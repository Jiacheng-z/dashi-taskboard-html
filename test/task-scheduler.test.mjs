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
if (args[0] === "app-server") { process.stdin.resume(); }
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
