import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { AiChatService } from "../server/ai-chat.mjs";
import { TaskboardDatabase } from "../server/database.mjs";

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function waitFor(predicate, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the ducc turn");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// 假 ducc：models 子命令给 catalog 用；其余情况记录 argv/cwd/stdin，
// 再把 argv 里的 --session-id / --resume 值回吐成 init 事件的 session_id
const FAKE_DUCC = `#!/bin/sh
if [ "$1" = "models" ]; then
  printf 'Available Models:\\n'
  printf 'Opus 5, Fable 5\\n'
  exit 0
fi
printf '%s\\n' "$PWD" > "$FAKE_DUCC_CWD_PATH"
printf '%s\\n' "$*" > "$FAKE_DUCC_ARGV_PATH"
cat > "$FAKE_DUCC_PROMPT_PATH"
session=""
previous=""
for argument in "$@"; do
  case "$previous" in
    --session-id|--resume) session="$argument" ;;
  esac
  previous="$argument"
done
printf '{"type":"system","subtype":"init","session_id":"%s","tools":["Bash"]}\\n' "$session"
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"已跑完"}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"input_tokens":7,"output_tokens":3}}'
`;

async function createFixture() {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "taskboard-backend-switch-")),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "workspace");
  const home = path.join(directory, "home");
  await mkdir(workspace);
  await mkdir(home);

  const executable = path.join(directory, "fake-ducc");
  await writeFile(executable, FAKE_DUCC);
  await chmod(executable, 0o755);

  const argvPath = path.join(directory, "argv.txt");
  const cwdPath = path.join(directory, "cwd.txt");
  const promptPath = path.join(directory, "prompt.txt");

  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  cleanups.push(() => database.close());
  database.createProject({ id: "project", name: "Project", workspacePath: workspace });

  const service = new AiChatService({
    database,
    manageTaskboardSkillPath: "/fixture/manage-taskboard/SKILL.md",
    processEnv: {
      // DUCC_EXECUTABLE 优先级更高，PATH 本身内容与后端选择无关；
      // 但 FAKE_DUCC 的 #!/bin/sh 脚本体内要能找到 cat/printf，
      // 所以不能像 agent-backend-ducc.test.mjs 里纯断言用的 "/nowhere-zzz" 那样彻底不可用
      PATH: `/nowhere-zzz:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      DUCC_EXECUTABLE: executable,
      FAKE_DUCC_ARGV_PATH: argvPath,
      FAKE_DUCC_CWD_PATH: cwdPath,
      FAKE_DUCC_PROMPT_PATH: promptPath,
    },
    // 绕开 resolveAiWorkspace，本用例只关心后端选择，不关心 workspace 解析
    resolveContext: async () => ({
      project: { id: "project", name: "Project" },
      workspacePath: workspace,
      addDirectories: [],
      issue: undefined,
    }),
    killGraceMs: 50,
  });
  cleanups.push(() => service.close());

  return { argvPath, cwdPath, database, promptPath, service, workspace };
}

test("a global ducc setting routes the whole turn through the ducc adapter", async () => {
  const fixture = await createFixture();
  fixture.database.setSetting("agent_backend", "ducc");

  const thread = await fixture.service.createThread({ projectId: "project" });
  assert.equal(thread.backend, "ducc");
  assert.equal(thread.model, "Opus 5");

  const run = await fixture.service.startTurn(thread.id, { message: "跑一下" });
  await waitFor(() => fixture.service.getRun(run.id).status === "completed");

  // 会话 id 就是我们自己生成的 thread id（规格 §5.2 的第一处简化）
  assert.equal(fixture.database.getAiChatThread(thread.id).codexThreadId, thread.id);
  // ducc 没有 -C，工作区只能靠子进程 cwd
  assert.equal((await readFile(fixture.cwdPath, "utf8")).trim(), fixture.workspace);
  const argv = (await readFile(fixture.argvPath, "utf8")).trim();
  assert.match(argv, /^-p --output-format stream-json --verbose --session-id /);
  // prompt 走 stdin，不进 argv
  assert.equal(argv.includes("跑一下"), false);
  assert.match(await readFile(fixture.promptPath, "utf8"), /跑一下/);

  assert.deepEqual(
    fixture.database.listAiChatEvents(thread.id).map((event) => event.type),
    ["user_message", "agent_message", "turn.completed"],
  );
});

test("the env var beats the settings row and an explicit option beats both", async () => {
  const fixture = await createFixture();
  fixture.database.setSetting("agent_backend", "codex");
  fixture.service.processEnv = { ...fixture.service.processEnv, TASKBOARD_AGENT_BACKEND: "ducc" };
  const fromEnv = await fixture.service.createThread({ projectId: "project" });
  assert.equal(fromEnv.backend, "ducc");

  fixture.service.agentBackendId = "codex";
  // codex catalog 会去 spawn 假 ducc 的 `debug models`，那不是本用例的关注点，
  // 只断言选中的后端，所以直接读私有解析结果的可观察出口：createThread 会抛在 catalog 上
  await assert.rejects(() => fixture.service.createThread({ projectId: "project" }));
});

test("a thread bound to another backend starts a new session instead of resuming", async () => {
  const fixture = await createFixture();
  fixture.database.setSetting("agent_backend", "ducc");
  const thread = await fixture.service.createThread({ projectId: "project" });
  // 造一条「上一轮是 codex 跑的」的历史
  fixture.database.updateAiChatThread(thread.id, {
    backend: "codex",
    codexThreadId: "codex-session-1",
  });

  const run = await fixture.service.startTurn(thread.id, { message: "接着改" });
  await waitFor(() => fixture.service.getRun(run.id).status === "completed");

  const argv = (await readFile(fixture.argvPath, "utf8")).trim();
  assert.equal(argv.includes("--resume"), false);
  assert.equal(argv.includes(`--session-id ${thread.id}`), true);

  const updated = fixture.database.getAiChatThread(thread.id);
  assert.equal(updated.backend, "ducc");
  assert.equal(updated.codexThreadId, thread.id);

  const notice = fixture.database.listAiChatEvents(thread.id)
    .find((event) => event.data?.backendSwitch);
  assert.equal(notice.type, "agent_message");
  assert.equal(notice.role, "activity");
  assert.deepEqual(notice.data.backendSwitch, { from: "codex", to: "ducc" });
  assert.match(notice.content, /后端已切换到 ducc/);
});
