import { buildAgentTaskPrompt } from "../shared/agent-task-prompt.mjs";
import { buildTaskctlCommand } from "../shared/taskboard-automation.mjs";
import { AGENT_ACTOR } from "../shared/agent-actor.mjs";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_INTERVAL_MS = 300_000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveSchedulerConfig({ database, processEnv }) {
  const env = processEnv ?? {};
  return {
    concurrency: positiveInteger(
      env.TASKBOARD_CONCURRENCY ?? database.getSetting("scheduler_concurrency"),
      DEFAULT_CONCURRENCY,
    ),
    intervalMs: positiveInteger(
      env.TASKBOARD_INTERVAL_MS ?? database.getSetting("scheduler_interval_ms"),
      DEFAULT_INTERVAL_MS,
    ),
  };
}

export class TaskScheduler {
  constructor(options) {
    this.database = options.database;
    this.aiChat = options.aiChat;
    this.manageTaskboardSkillPath = options.manageTaskboardSkillPath;
    this.processEnv = options.processEnv ?? process.env;
    // key = projectId，value = 上次认领的毫秒时间戳。只在内存里，重启即失效，
    // 重启后第一轮不受 per-project intervalSeconds 限制（见「与规格的偏离」第二处）
    this.lastClaimedAt = new Map();
    this.timer = null;
    this.running = false;
    // 已认领但 ai_chat_runs 行还没建出来的任务 id。并发闸门要把这批算进去，
    // 否则一轮里连开 N 个 startTurn 时 COUNT(*) 还是 0，上限形同虚设（任务 9）
    this.pending = new Set();
  }

  config() {
    return resolveSchedulerConfig({ database: this.database, processEnv: this.processEnv });
  }

  claimTask(task) {
    try {
      return this.database.moveTask(
        task.id,
        task.version,
        "in_progress",
        undefined,
        null,
        AGENT_ACTOR,
      );
    } catch (error) {
      // 另一个 scheduler 实例（或用户手动拖动）先改了这条 → 放弃，不重试
      if (error?.code === "VERSION_CONFLICT") return null;
      throw error;
    }
  }

  async ensureThread(task, automation) {
    const existing = this.database.findAiChatThreadByIssueId(task.id);
    // 跨 backend 不能 resume 的处理在 startTurn 里（server/ai-chat.mjs:292-299），此处不重复
    if (existing) return existing;
    return this.aiChat.createThread({
      projectId: task.projectId,
      issueId: task.id,
      // automation 里这两项默认是 null，null 会被 #requireKnownModel 判为非法，必须条件展开
      ...(automation.model ? { model: automation.model } : {}),
      ...(automation.reasoningEffort ? { reasoningEffort: automation.reasoningEffort } : {}),
    });
  }

  waitForRun(threadId, runId) {
    return new Promise((resolve) => {
      const settle = (run) => {
        unsubscribe();
        resolve(run);
      };
      const unsubscribe = this.aiChat.subscribe(threadId, (event) => {
        if (event.type !== "ai.run") return;
        if (event.run.id !== runId || event.run.status === "running") return;
        settle(event.run);
      });
      // 进程可能在订阅之前就退出了（#finishRun 已经 emit 完），补查一次兜住这个竞态
      const current = this.aiChat.getRun(runId);
      if (current.status !== "running") settle(current);
    });
  }

  async runTask(task, project, onStarted) {
    const thread = await this.ensureThread(task, project.automation);
    const prompt = buildAgentTaskPrompt({
      task,
      comments: this.database.listComments(task.id),
      project: {
        id: project.projectId,
        name: project.projectName,
        workspacePath: project.workspacePath,
      },
      skillPath: this.manageTaskboardSkillPath,
      taskctlCommand: buildTaskctlCommand({ skillPath: this.manageTaskboardSkillPath }),
    });
    const run = await this.aiChat.startTurn(thread.id, { message: prompt });
    // run 行已经落库，从这一刻起并发计数交给 countRunningAiChatRuns()（任务 9 传这个回调）
    onStarted?.();
    return this.waitForRun(thread.id, run.id);
  }

  finalize(task, run) {
    const current = this.database.getTask(task.id);
    // agent 自己收过尾（in_review），或任务被人手挪走了 → 不插手
    if (!current || current.status !== "in_progress") return current;

    const details = [
      `run 状态：${run.status}`,
      `退出码：${run.exitCode ?? "（无，进程被信号终止或被中断）"}`,
      run.error ? `错误：${run.error}` : null,
    ].filter(Boolean).join("\n");
    this.database.createComment(task.id, {
      body: `⚠️ 执行未完成\n\n${details}\n\nagent 退出时这条任务仍停在「处理中」，已自动移到「等你确认」，请人工看一眼。`,
      threadId: null,
      actor: AGENT_ACTOR,
    });

    const fresh = this.database.getTask(task.id);
    return this.database.moveTask(
      fresh.id,
      fresh.version,
      "in_review",
      undefined,
      null,
      AGENT_ACTOR,
    );
  }

  async #execute(task, project) {
    this.pending.add(task.id);
    try {
      const run = await this.runTask(task, project, () => this.pending.delete(task.id));
      this.finalize(task, run);
    } catch (error) {
      // createThread / startTurn 自己抛错（THREAD_BUSY、AI_CHAT_ISSUE_NOT_FOUND 等）也要兜底，
      // 否则任务永远卡在 in_progress 占着名额
      this.finalize(task, {
        status: "failed",
        exitCode: null,
        error: error?.message ?? String(error),
      });
    } finally {
      this.pending.delete(task.id);
    }
  }

  async tick() {
    const { concurrency } = this.config();
    const startedAt = Date.now();
    const started = [];
    for (const project of this.database.listProjectsWithAutomationEnabled()) {
      const lastClaimedAt = this.lastClaimedAt.get(project.projectId);
      const gapMs = project.automation.intervalSeconds * 1000;
      if (lastClaimedAt !== undefined && startedAt - lastClaimedAt < gapMs) continue;
      const todos = this.database.listTasks({
        projectId: project.projectId,
        status: "todo",
        archived: "false",
      });
      for (const task of todos) {
        if (this.database.countRunningAiChatRuns() + this.pending.size >= concurrency) {
          return started;
        }
        const claimed = this.claimTask(task);
        if (!claimed) continue;
        this.lastClaimedAt.set(project.projectId, Date.now());
        started.push(this.#execute(claimed, project));
      }
    }
    return started;
  }

  nextDelayMs() {
    const globalMs = this.config().intervalMs;
    let shortest = globalMs;
    for (const project of this.database.listProjectsWithAutomationEnabled()) {
      const ms = project.automation.intervalSeconds * 1000;
      if (ms < shortest) shortest = ms;
    }
    return shortest;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      try {
        await this.tick();
      } catch (error) {
        console.error("[task-scheduler] tick failed:", error);
      }
      if (!this.running) return;
      this.timer = setTimeout(loop, this.nextDelayMs());
      this.timer.unref?.();
    };
    this.timer = setTimeout(loop, this.nextDelayMs());
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
