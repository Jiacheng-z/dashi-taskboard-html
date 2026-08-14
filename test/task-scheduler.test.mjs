import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { AiChatService } from "../server/ai-chat.mjs";
import { TaskScheduler, resolveSchedulerConfig } from "../server/task-scheduler.mjs";

async function waitFor(predicate, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

const ACTOR = { type: "user", id: "scheduler-tester", name: "Scheduler Tester", avatarUrl: null };

async function createFixture({ concurrency, intervalMs, holdMs } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-scheduler-"));
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath);
  const workspace = await realpath(workspacePath);
  const capturePath = path.join(directory, "capture.jsonl");
  const executable = path.join(directory, "fake-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "debug" && args[1] === "models") {
  process.stdout.write(JSON.stringify({models:[{
    slug:"gpt-real", display_name:"GPT Real", description:"fixture",
    default_reasoning_level:"medium",
    supported_reasoning_levels:[{effort:"low"},{effort:"medium"},{effort:"high"}]
  }]}));
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "list") { process.stdout.write("[]"); process.exit(0); }
if (args[0] === "app-server") {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === 1) process.stdout.write('{"id":1,"result":{"platformFamily":"unix"}}\\n');
      if (message.id === 2) process.stdout.write('{"id":2,"result":{"data":[]}}\\n');
    }
  });
}
else if (args[0] === "exec") {
  process.stdin.setEncoding("utf8");
  let prompt = "";
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    appendFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify({args,prompt}) + "\\n");
    const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    if (!args.includes("resume")) emit({type:"thread.started",thread_id:"codex-" + Date.now() + "-" + Math.random()});
    emit({type:"turn.started"});
    const hold = Number(process.env.FAKE_HOLD_MS ?? 0);
    const finish = () => {
      if (prompt.includes("EXIT_NONZERO")) { process.stderr.write("boom: fake failure tail\\n"); process.exit(9); }
      emit({type:"item.completed",item:{type:"agent_message",text:"done"}});
      emit({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}});
    };
    if (hold > 0) setTimeout(finish, hold); else finish();
  });
}
`);
  await chmod(executable, 0o755);

  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "project", name: "Project", workspacePath: workspace });
  if (concurrency !== undefined) database.setSetting("scheduler_concurrency", String(concurrency));
  if (intervalMs !== undefined) database.setSetting("scheduler_interval_ms", String(intervalMs));

  const processEnv = {
    ...process.env,
    FAKE_CAPTURE_PATH: capturePath,
    // holdMs 让假可执行文件在退出前挂住，用来构造「多个 run 同时 running」的局面（任务 9 要用）
    ...(holdMs ? { FAKE_HOLD_MS: String(holdMs) } : {}),
  };
  const aiChat = new AiChatService({
    database,
    agentBackendId: "codex",
    codexExecutable: executable,
    codexStatePath: path.join(directory, "missing-codex-state.json"),
    manageTaskboardSkillPath: path.join(directory, "skills/manage-taskboard/SKILL.md"),
    processEnv,
    killGraceMs: 50,
  });
  const scheduler = new TaskScheduler({
    database,
    aiChat,
    manageTaskboardSkillPath: path.join(directory, "skills/manage-taskboard/SKILL.md"),
    processEnv,
  });

  return {
    aiChat, capturePath, database, directory, executable, processEnv, scheduler, workspace,
    createTodo(title) {
      return database.createTask({
        projectId: "project",
        title,
        description: "",
        status: "todo",
        priority: "none",
        labels: [],
        threadId: null,
        actor: ACTOR,
        assignee: ACTOR,
        workflowId: null,
        developmentContext: null,
        startDate: null,
        dueDate: null,
        recurrence: null,
      });
    },
    async captured() {
      try {
        return (await readFile(capturePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch { return []; }
    },
    async close() {
      scheduler.stop();
      await aiChat.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("scheduler config falls back to defaults, then settings, then env", async () => {
  const fixture = await createFixture();
  try {
    const { database } = fixture;
    assert.deepEqual(resolveSchedulerConfig({ database, processEnv: {} }), {
      concurrency: 2,
      intervalMs: 300_000,
    });

    database.setSetting("scheduler_concurrency", "4");
    database.setSetting("scheduler_interval_ms", "60000");
    assert.deepEqual(resolveSchedulerConfig({ database, processEnv: {} }), {
      concurrency: 4,
      intervalMs: 60_000,
    });

    // 环境变量单次覆盖，优先于 settings，且不写库
    assert.equal(
      resolveSchedulerConfig({ database, processEnv: { TASKBOARD_CONCURRENCY: "1" } }).concurrency,
      1,
    );
    assert.equal(database.getSetting("scheduler_concurrency"), "4");

    // 垃圾值一律落回默认，不抛
    database.setSetting("scheduler_concurrency", "not-a-number");
    database.setSetting("scheduler_interval_ms", "-5");
    assert.deepEqual(resolveSchedulerConfig({ database, processEnv: {} }), {
      concurrency: 2,
      intervalMs: 300_000,
    });
  } finally {
    await fixture.close();
  }
});

test("claimTask 把 todo 推到 in_progress，版本冲突时返回 null", async () => {
  const fixture = await createFixture();
  try {
    const task = fixture.createTodo("认领我");
    const claimed = fixture.scheduler.claimTask(task);
    assert.equal(claimed.status, "in_progress");
    assert.equal(claimed.version, task.version + 1);

    // 拿过期的 version 再认领一次：模拟另一个 scheduler 实例已抢走
    assert.equal(fixture.scheduler.claimTask(task), null);
    assert.equal(fixture.database.getTask(task.id).status, "in_progress");
    assert.equal(fixture.database.getTask(task.id).version, task.version + 1);
  } finally {
    await fixture.close();
  }
});

test("每条任务各自建 thread，已绑定的任务复用原 thread", async () => {
  const fixture = await createFixture();
  try {
    const automation = { model: null, reasoningEffort: null };
    const first = fixture.createTodo("任务甲");
    const second = fixture.createTodo("任务乙");

    const threadA = await fixture.scheduler.ensureThread(first, automation);
    const threadB = await fixture.scheduler.ensureThread(second, automation);
    assert.notEqual(threadA.id, threadB.id);
    assert.equal(threadA.origin.issueId, first.id);
    assert.equal(threadB.origin.issueId, second.id);

    // 同一条任务再来一轮（规格 §7.5 路径 B：人手拖回 todo）→ 复用而非新建
    const again = await fixture.scheduler.ensureThread(first, automation);
    assert.equal(again.id, threadA.id);
    assert.equal(fixture.database.listAiChatThreads().length, 2);
  } finally {
    await fixture.close();
  }
});

test("runTask 把议题正文与评论送进 prompt，并等到 run 落终态", async () => {
  const fixture = await createFixture();
  try {
    const task = fixture.createTodo("修一个 bug");
    fixture.database.createComment(task.id, {
      body: "顺手把日志也补上",
      threadId: null,
      actor: ACTOR,
    });
    const project = {
      projectId: "project",
      projectName: "Project",
      workspacePath: fixture.workspace,
      automation: { model: null, reasoningEffort: null },
    };

    const run = await fixture.scheduler.runTask(task, project);
    assert.equal(run.status, "completed");

    const [capture] = await fixture.captured();
    assert.equal(capture.prompt.includes(task.identifier), true);
    assert.equal(capture.prompt.includes("修一个 bug"), true);
    assert.equal(capture.prompt.includes("顺手把日志也补上"), true);
    assert.equal(capture.prompt.includes("禁止任何 git 写操作"), true);
    assert.equal(capture.prompt.includes("cli/taskctl.mjs"), true);
  } finally {
    await fixture.close();
  }
});

test("agent 没收尾时兜底评论并落 in_review；已收尾则不插手", async () => {
  const fixture = await createFixture();
  const project = {
    projectId: "project",
    projectName: "Project",
    workspacePath: fixture.workspace,
    automation: { model: null, reasoningEffort: null },
  };
  try {
    // 情形一：假可执行文件 exit 9，任务仍停在 in_progress
    const failing = fixture.scheduler.claimTask(fixture.createTodo("EXIT_NONZERO 故意失败"));
    const failedRun = await fixture.scheduler.runTask(failing, project);
    assert.equal(failedRun.status, "failed");
    const finalized = fixture.scheduler.finalize(failing, failedRun);
    assert.equal(finalized.status, "in_review");
    const comment = fixture.database.listComments(failing.id).at(-1);
    assert.equal(comment.body.startsWith("⚠️ 执行未完成"), true);
    assert.equal(comment.body.includes("9"), true);
    assert.equal(comment.authorId, "codex-agent");

    // 情形二：agent 自己已经置了 in_review → finalize 不加评论、不改状态
    const done = fixture.scheduler.claimTask(fixture.createTodo("正常完成"));
    const okRun = await fixture.scheduler.runTask(done, project);
    const moved = fixture.database.moveTask(
      done.id, done.version, "in_review", undefined, null, ACTOR,
    );
    const after = fixture.scheduler.finalize(moved, okRun);
    assert.equal(after.status, "in_review");
    assert.equal(fixture.database.listComments(done.id).length, 0);
  } finally {
    await fixture.close();
  }
});
