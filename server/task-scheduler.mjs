import { buildAgentTaskPrompt } from "../shared/agent-task-prompt.mjs";
import { buildTaskctlCommand } from "../shared/taskboard-automation.mjs";

export const SCHEDULER_ACTOR = {
  type: "agent",
  // 与 app.mjs 的 CODEX_AGENT_ACTOR 保持同一个 wire 值：assignee 过滤、
  // 历史评论的 actor.id 都认这个字符串，换 backend 也不能换它（见「与规格的偏离」）
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};

const DEFAULT_CONCURRENCY = 2;
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
    // 重启后第一轮不受 per-project intervalMinutes 限制（见「与规格的偏离」第二处）
    this.lastClaimedAt = new Map();
    this.timer = null;
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
        SCHEDULER_ACTOR,
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

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
