# 后端可插拔基础设施（A1）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 `AiChatService` 通过一层 backend adapter 驱动 `ducc` 或 `codex`，切换是全局的、在每次 spawn 的那一刻读取；codex 现有行为零变化。

**架构：** 接缝选在事件 schema `{kind,type,role,content,data}`。每个 backend 一个模块，导出 `{ id, resolveExecutable, needsCwd, spawnGapMs, buildArgs, buildPrompt, createNormalizer, discoverCatalog }`。`createNormalizer()` 每个 turn 调一次并返回归一化函数——codex 那个无状态，ducc 那个要按 `tool_use_id` 关联 tool_use 与 tool_result（见任务 7 开头的解释）。`AiChatService` 不再直接 import codex 函数，改为 `resolveAgentBackend(database.getSetting("agent_backend"))`。进程管理骨架 `spawnCodexTurn` 与 `ai-turn-owner.mjs` 保持不变，只加一个 `cwd` 参数（codex 靠 `-C` 传工作区，ducc 没有这个 flag，必须靠子进程 cwd）。

**技术栈：** Node ≥22.5 ESM、`node:sqlite` 的 `DatabaseSync`、`node --test`。本计划不改任何前端文件。

---

## 与规格的偏离（实测后修正，共 4 处）

规格 `docs/superpowers/specs/2026-08-13-taskboard-local-agent-design.md` 里有 4 条基于推测的判断，实测后不成立，本计划按实测走：

| # | 规格原文 | 实测结果 | 本计划怎么做 |
|---|---|---|---|
| 1 | §5.2 表格：ducc 启动是 `-p <prompt>` | `printf '...' \| ducc -p --output-format stream-json --verbose` **成功**，prompt 走 stdin | prompt 走 stdin，与 codex 的 `-` 完全一致。`spawnCodexTurn` 的 `child.stdin.end(prompt)` 不用改，prompt 也不会出现在 `ps` 里 |
| 2 | §5.2 / §5.5：模型列表用 `ducc models`，与 codex 的 `codex debug models` 对等 | `ducc models` 输出**纯文本**：第一行 `Available Models:`，第二行逗号分隔 26 个名字（含空格与中文，如 `Claude Opus 4.6`、`auto-内部`），不是 JSON | ducc 的 `discoverCatalog` 解析这两行文本；reasoning effort 走 `--effort`（choices: low/medium/high/max，来自 `ducc --help`） |
| 3 | §5.2 / §5.5：ducc 的 skill 列表由 init 事件直接带 `skills` 字段，省掉额外子进程 | init **确实**带 `skills`，但（a）catalog 在 spawn **之前**就要用（`createThread` 要校验 model），拿不到 init；（b）`skills` 只有名字**没有路径**，而 prompt 的 `[$id](path)` 引用格式必须有路径；（c）`ducc skill list` 只列 9 个用户级 skill，init 报了 18 个（缺 project 级） | ducc 的 `discoverCatalog` 直接扫文件系统：`<workspace>/.claude/skills/*/SKILL.md`（scope `repo`）+ `~/.claude/skills/*/SKILL.md`（scope `user`），既有 id 又有 path，无子进程 |
| 4 | §5.1：adapter 放 `shared/agent-backends/` | codex 的 `discoverCatalog` 要复用 `server/ai-chat-catalog.mjs` 的 `sanitizeModels`/`listSkills`（250 行，含 app-server RPC）。放 `shared/` 会造成 `shared/` → `server/` 反向依赖 | 放 `server/agent-backends/`。唯一消费者就是 server 进程（scheduler 在进程内跑，npm 脚本只是 HTTP 客户端），`shared/` 没有任何东西需要它 |

另外两条实测补充，写进代码注释：

- `ducc --model no-such-model-zzz` **不报错，直接静默挂住**（60s 无任何输出，timeout 124 退出）。所以非法模型不会走 `turn.failed` 路径，只能靠现有的「无终止事件 → failed」兜底（`ai-chat.mjs` 的 `terminalOutcome === null` 分支，已有 `NO_TERMINAL` 测试覆盖）。
- ducc 的终止事件是 `{"type":"result","subtype":"success","is_error":false,...}`，失败时 `is_error:true`。没有独立的 `turn.failed`。

---

## 文件结构

**新建：**

| 文件 | 职责 |
|---|---|
| `server/agent-backends/codex.mjs` | codex adapter。内容是从 `ai-chat-process.mjs` 原样搬来的 `buildCodexArgs`/`buildCodexPrompt`/`normalizeCodexEvent` + 内部辅助函数，末尾加一个 adapter 对象 |
| `server/agent-backends/ducc.mjs` | ducc adapter。全新代码：`buildArgs`（`-p` + stdin）、`createDuccNormalizer`（stream-json → 统一 schema，按 `tool_use_id` 关联）、`discoverCatalog`（`ducc models` 文本 + 扫 SKILL.md） |
| `server/agent-backends/index.mjs` | registry。`AGENT_BACKENDS` 映射 + `resolveAgentBackend(id)` + `agentBackendIds()` + `DEFAULT_AGENT_BACKEND = "ducc"` |
| `server/agent-backends/spawn-gate.mjs` | 按后端分别排队的启动闸门，让 `spawnGapMs` 真正生效（`bin/ducc` 每次启动都 `sed -i` 同一份 settings，并发会撞写） |
| `test/settings-store.test.mjs` | settings 表读写 |
| `test/agent-backend-codex.test.mjs` | codex adapter 的 `buildArgs` 参数数组 + 归一结果（规格 §9.2「两套 adapter」） |
| `test/agent-backend-ducc.test.mjs` | 同上，ducc 侧 |
| `test/agent-backend-ducc-catalog.test.mjs` | `ducc models` 文本解析 + `.claude/skills` 扫描（用假可执行文件与临时 HOME） |
| `test/agent-backend-switch.test.mjs` | 全局切换生效 + backend 不同不 resume + 模型落回默认（规格 §9.2「backend 不同不 resume」） |
| `test/spawn-gate.test.mjs` | 闸门的间隔、零间隔不等待、不同后端互不阻塞 |

**修改：**

| 文件 | 改什么 |
|---|---|
| `server/database.mjs` | `settings` 表 DDL；`ai_chat_threads` ADD COLUMN `backend`；`aiChatThreadFromRow` 加 `backend`；`createAiChatThread` INSERT 加列；`updateAiChatThread` 的 `columns` 映射加 `backend`；新增 `getSetting`/`setSetting` |
| `server/ai-turn-owner.mjs` | 第 4 行取第三个 argv 作 cwd，第 7 行 spawn 传 `cwd` |
| `server/ai-chat-process.mjs` | 剪掉第 6、8、10-333 行（搬去 codex adapter），改为 re-export；`spawnCodexTurn` 签名加 `cwd` |
| `server/ai-chat.mjs` | `#catalogForWorkspace`、`createThread`、`startTurn` 改走 adapter；新增 `#backend()`/`#executableFor()`；resume 前比 `thread.backend`；`#resolveModel` 改为落回默认而非抛错；spawn 前过闸门 |
| `server/app.mjs` | 透传 `agentBackendId`；新增 `GET/PATCH /api/local/ai/backend` |

---

## 任务 1：settings 表与读写

**文件：**
- 修改：`server/database.mjs:517`（DDL）、`server/database.mjs:1330`（方法）
- 测试：`test/settings-store.test.mjs`（创建）

- [ ] **步骤 1：编写失败的测试**

创建 `test/settings-store.test.mjs`：

```js
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

test("settings store upserts by key and returns null for unknown keys", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-settings-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  try {
    assert.equal(database.getSetting("agent_backend"), null);

    assert.equal(database.setSetting("agent_backend", "ducc"), "ducc");
    assert.equal(database.getSetting("agent_backend"), "ducc");

    assert.equal(database.setSetting("agent_backend", "codex"), "codex");
    assert.equal(database.getSetting("agent_backend"), "codex");
    assert.equal(
      database.database.prepare("SELECT COUNT(*) AS total FROM settings").get().total,
      1,
    );

    const row = database.database
      .prepare("SELECT updated_at FROM settings WHERE key = 'agent_backend'").get();
    assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /home/work/vdc/dashi-taskboard && node --test test/settings-store.test.mjs`
预期：FAIL，报错 `database.getSetting is not a function`

- [ ] **步骤 3：加 DDL**

在 `server/database.mjs` 的 `#migrate()` 里，紧跟 `ai_chat_events_thread_created` 索引（517 行）之后、`` ` ``\`);\`（519 行）之前插入：

```sql
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL
      );

```

- [ ] **步骤 4：加读写方法**

在 `server/database.mjs` 的 `createAiChatThread(input) {`（1330 行）**之前**插入：

```js
  getSetting(key) {
    const row = this.database.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : null;
  }

  setSetting(key, value) {
    this.database.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now());
    return this.getSetting(key);
  }

```

- [ ] **步骤 5：运行测试验证通过**

运行：`node --test test/settings-store.test.mjs`
预期：PASS，`# pass 1`

- [ ] **步骤 6：Commit**

```bash
cd /home/work/vdc/dashi-taskboard
git add server/database.mjs test/settings-store.test.mjs
git commit -m "feat(db): add settings key-value store"
```

---

## 任务 2：`ai_chat_threads.backend` 留痕列

这一列**任何 UI 里都不出现**。唯一用途：`codex_thread_id` 存的是后端私有的会话 id，ducc 认不了 codex 的 id，resume 前必须比这一列。

**文件：**
- 修改：`server/database.mjs:300-321`（`aiChatThreadFromRow`）、`:519`（迁移）、`:1330-1358`（`createAiChatThread`）、`:1360-1387`（`updateAiChatThread`）
- 测试：`test/ai-chat-database.test.mjs`（追加）

- [ ] **步骤 1：编写失败的测试**

在 `test/ai-chat-database.test.mjs` 末尾追加（`import` 已有，沿用文件里现成的 fixture 写法；若该文件没有可复用的 fixture，就照下面这段自建 tmpdir）：

```js
test("threads persist the backend that produced their session id", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-thread-backend-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  try {
    database.createProject({ id: "project", name: "Project", workspacePath: null });
    const created = database.createAiChatThread({
      title: "T",
      origin: { projectId: "project", projectName: "Project", workspacePath: "/tmp/ws" },
      model: "Opus 5",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
      backend: "ducc",
    });
    assert.equal(created.backend, "ducc");

    const legacy = database.createAiChatThread({
      title: "L",
      origin: { projectId: "project", projectName: "Project", workspacePath: "/tmp/ws" },
      model: "Opus 5",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    assert.equal(legacy.backend, null);

    const updated = database.updateAiChatThread(legacy.id, { backend: "codex" });
    assert.equal(updated.backend, "codex");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/ai-chat-database.test.mjs`
预期：FAIL，`created.backend` 是 `undefined` 而非 `"ducc"`

- [ ] **步骤 3：加迁移**

在 `server/database.mjs` 的 `const projectColumns = ...`（521 行）**之前**插入：

```js
    const aiChatThreadColumns = this.database
      .prepare("PRAGMA table_info(ai_chat_threads)").all();
    if (!aiChatThreadColumns.some((column) => column.name === "backend")) {
      this.database.exec("ALTER TABLE ai_chat_threads ADD COLUMN backend TEXT");
    }

```

- [ ] **步骤 4：行映射加 backend**

在 `server/database.mjs` 的 `aiChatThreadFromRow` 里，把

```js
    codexThreadId: row.codex_thread_id,
```

改成

```js
    // 列名保留历史叫法，语义是「后端侧会话 id」：codex 是 thread id，ducc 是 --session-id
    codexThreadId: row.codex_thread_id,
    // 产出上面那个 id 的后端。纯留痕，不进任何 UI；resume 前用它判断 id 是否还认得
    backend: row.backend ?? null,
```

- [ ] **步骤 5：写入与更新支持 backend**

`createAiChatThread` 的 INSERT 列表把 `codex_thread_id, model, reasoning_effort,` 改成 `codex_thread_id, backend, model, reasoning_effort,`，占位符从 14 个 `?` 加到 15 个，并把 `.run(...)` 里 `input.codexThreadId ?? null,` 后面补一项：

```js
         input.codexThreadId ?? null, input.backend ?? null, input.model, input.reasoningEffort, input.sandbox,
```

`updateAiChatThread` 的 `columns` 映射加一项：

```js
    const columns = {
      title: "title",
      status: "status",
      codexThreadId: "codex_thread_id",
      backend: "backend",
      model: "model",
      reasoningEffort: "reasoning_effort",
      sandbox: "sandbox",
    };
```

- [ ] **步骤 6：运行测试验证通过**

运行：`node --test test/ai-chat-database.test.mjs test/ai-chat-runner.test.mjs`
预期：全 PASS。`ai-chat-runner` 一起跑是为了确认 INSERT 的占位符数量没写错——数量不匹配会在 `createAiChatThread` 直接抛错。

- [ ] **步骤 7：Commit**

```bash
git add server/database.mjs test/ai-chat-database.test.mjs
git commit -m "feat(db): record which backend owns a thread session id"
```

---

## 任务 3：`ai-turn-owner.mjs` 支持 cwd

codex 靠 `-C <workspace>` 指定工作区；ducc 没有这个 flag（`ducc --help` 里不存在），只能靠子进程的 cwd。当前 `ai-turn-owner.mjs:7` 的 spawn **没有传 cwd**，`spawnCodexTurn`（`ai-chat-process.mjs:336`）也没有。

**文件：**
- 修改：`server/ai-turn-owner.mjs:4,7-10`、`server/ai-chat-process.mjs:335-340`
- 测试：`test/agent-backend-cwd.test.mjs`（创建）

- [ ] **步骤 1：编写失败的测试**

创建 `test/agent-backend-cwd.test.mjs`：

```js
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { spawnCodexTurn } from "../server/ai-chat-process.mjs";

test("spawnCodexTurn runs the executable in the requested cwd", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-cwd-"));
  try {
    const workspace = await realpath(await mkdir(path.join(directory, "ws"), { recursive: true })
      .then(() => path.join(directory, "ws")));
    const capturePath = path.join(directory, "cwd.txt");
    const executable = path.join(directory, "fake-cwd.mjs");
    await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_CWD_PATH, process.cwd());
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`);
    await chmod(executable, 0o755);

    const { completion } = spawnCodexTurn({
      executable,
      args: [],
      prompt: "",
      cwd: workspace,
      env: { ...process.env, FAKE_CWD_PATH: capturePath },
      onRawEvent: () => {},
    });
    await completion;

    assert.equal((await readFile(capturePath, "utf8")).trim(), workspace);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/agent-backend-cwd.test.mjs`
预期：FAIL，捕获到的 cwd 是 taskboard 仓库根目录而不是 `workspace`

- [ ] **步骤 3：改 owner**

`server/ai-turn-owner.mjs` 第 4-10 行整段替换为：

```js
const [executable, encodedArgs, cwd] = process.argv.slice(2);
if (!executable || !encodedArgs) process.exit(2);

const child = spawn(executable, JSON.parse(encodedArgs), {
  cwd: cwd || undefined,
  env: process.env,
  stdio: "inherit",
});
```

- [ ] **步骤 4：改 spawnCodexTurn**

`server/ai-chat-process.mjs:335-340`，把

```js
export function spawnCodexTurn({ executable, args, prompt, env, onRawEvent, maxLineBytes = 1_048_576 }) {
  const child = spawn(process.execPath, [TURN_OWNER_PATH, executable, JSON.stringify(args)], {
    detached: true,
    env: withoutTaskboardLauncherEnvironment(env),
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
```

改成

```js
export function spawnCodexTurn({
  executable, args, prompt, env, cwd, onRawEvent, maxLineBytes = 1_048_576,
}) {
  const child = spawn(
    process.execPath,
    [TURN_OWNER_PATH, executable, JSON.stringify(args), cwd ?? ""],
    {
      detached: true,
      env: withoutTaskboardLauncherEnvironment(env),
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );
```

- [ ] **步骤 5：运行测试验证通过**

运行：`node --test test/agent-backend-cwd.test.mjs test/ai-chat-runner.test.mjs`
预期：全 PASS。`ai-chat-runner` 必须一起跑：它和 `server/project-summary.mjs` 都调 `spawnCodexTurn` 且不传 `cwd`，`cwd ?? ""` → `cwd: undefined` 保持原行为。

- [ ] **步骤 6：Commit**

```bash
git add server/ai-turn-owner.mjs server/ai-chat-process.mjs test/agent-backend-cwd.test.mjs
git commit -m "feat(ai): let turn owner run the backend in an explicit cwd"
```

---

## 任务 4：抽出 codex adapter（纯搬迁，行为必须零变化）

这一任务**不新增任何逻辑**。判定标准就一条：搬完 `npm test` 与搬前完全一致。

**文件：**
- 创建：`server/agent-backends/codex.mjs`
- 修改：`server/ai-chat-process.mjs:1-333`

- [ ] **步骤 1：先记录基线**

运行：`cd /home/work/vdc/dashi-taskboard && npm test 2>&1 | tail -20`
把 `# pass` / `# fail` 的数字抄下来，搬迁后要一模一样。

- [ ] **步骤 2：新建 adapter 文件并搬入代码**

创建 `server/agent-backends/codex.mjs`。开头写：

```js
import { resolveCodexExecutable } from "../../shared/codex-executable.mjs";
import { discoverAiCatalog } from "../ai-chat-catalog.mjs";
```

然后把 `server/ai-chat-process.mjs` 的以下行**原样剪切**过来（顺序不变）：

| 源文件行 | 内容 |
|---|---|
| 6 | `const VISIBLE_TEXT_LIMIT = 65_536;` |
| 8 | `const SKILL_MARKER = "\uFFFC";` |
| 10-18 | `const ITEM_TYPES = new Set([...]);` |
| 20-43 | `cappedText` / `errorMessage` / `detailText` / `itemStatus` |
| 45-161 | `normalizedItem` |
| 163-218 | `buildCodexArgs` |
| 220-258 | `buildCodexPrompt` |
| 260-333 | `normalizeCodexEvent` |

**留在 `ai-chat-process.mjs` 不动的**：第 1 行 `spawn` import、第 2 行 `fileURLToPath` import、第 4 行 `withoutTaskboardLauncherEnvironment` import、第 7 行 `STDERR_LIMIT`、第 9 行 `TURN_OWNER_PATH`、第 335-471 行 `spawnCodexTurn`。

- [ ] **步骤 3：文件末尾加 adapter 对象**

在 `server/agent-backends/codex.mjs` 末尾追加：

```js
export const codexBackend = {
  id: "codex",
  // codex app 的自动化链路已废弃，但可执行文件解析仍沿用旧逻辑：
  // CODEX_EXECUTABLE 显式指定 > .app bundle > PATH > 字面量 "codex"
  resolveExecutable: ({ appPath, env } = {}) => resolveCodexExecutable({ appPath, env }),
  // codex 用 -C 指定工作区，不需要子进程 cwd
  needsCwd: false,
  // codex 没有共享配置文件的并发写竞争
  spawnGapMs: 0,
  buildArgs: buildCodexArgs,
  buildPrompt: buildCodexPrompt,
  // codex 的归一化是无状态的，所以每个 turn 拿到的都是同一个函数。
  // 契约里之所以是 createNormalizer 而不是直接给函数，是为了 ducc ——
  // 它要在一个 turn 内攒 tool_use → tool_result 的对应关系（见任务 7）。
  createNormalizer: () => normalizeCodexEvent,
  // 直接暴露一份供单测断言用，运行时路径只走 createNormalizer()
  normalizeEvent: normalizeCodexEvent,
  discoverCatalog: ({ executable, workspacePath, processEnv }) => discoverAiCatalog({
    codexExecutable: executable,
    workspacePath,
    processEnv,
  }),
};
```

- [ ] **步骤 4：`ai-chat-process.mjs` 改为 re-export**

在 `server/ai-chat-process.mjs` 第 4 行之后插入：

```js
// 三个函数已搬到 codex adapter；这里 re-export 只为不改动既有 import 点
// （server/ai-chat.mjs、test/ai-chat-runner.test.mjs）
export {
  buildCodexArgs,
  buildCodexPrompt,
  normalizeCodexEvent,
} from "./agent-backends/codex.mjs";
```

- [ ] **步骤 5：运行全量测试验证零变化**

运行：`npm test 2>&1 | tail -20`
预期：`# pass` / `# fail` 与步骤 1 抄下来的数字**完全相同**。任何一条从 pass 变 fail 就是搬漏了。

- [ ] **步骤 6：Commit**

```bash
git add server/agent-backends/codex.mjs server/ai-chat-process.mjs
git commit -m "refactor(ai): extract the codex backend adapter"
```

---

## 任务 5：backend registry

**文件：**
- 创建：`server/agent-backends/index.mjs`
- 测试：`test/agent-backend-codex.test.mjs`（创建，本任务先只测 registry 和 codex 侧）

- [ ] **步骤 1：编写失败的测试**

创建 `test/agent-backend-codex.test.mjs`：

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_AGENT_BACKEND, resolveAgentBackend } from "../server/agent-backends/index.mjs";

test("registry defaults to ducc and falls back for unknown ids", () => {
  assert.equal(DEFAULT_AGENT_BACKEND, "ducc");
  assert.equal(resolveAgentBackend("ducc").id, "ducc");
  assert.equal(resolveAgentBackend("codex").id, "codex");
  assert.equal(resolveAgentBackend(null).id, "ducc");
  assert.equal(resolveAgentBackend(undefined).id, "ducc");
  assert.equal(resolveAgentBackend("gemini-whatever").id, "ducc");
});

test("codex adapter builds the same argv it always did", () => {
  const backend = resolveAgentBackend("codex");
  const thread = {
    origin: { workspacePath: "/ws" },
    sandbox: "workspace-write",
    model: "gpt-5.5",
    reasoningEffort: "high",
    codexThreadId: null,
  };
  assert.deepEqual(backend.buildArgs(thread, ["/other"], []), [
    "exec", "--json", "--color", "never",
    "-C", "/ws",
    "-s", "workspace-write",
    "-c", 'approval_policy="on-request"',
    "-c", 'approvals_reviewer="auto_review"',
    "--add-dir", "/other",
    "-m", "gpt-5.5",
    "-c", 'model_reasoning_effort="high"',
    "-",
  ]);
  assert.deepEqual(
    backend.buildArgs({ ...thread, codexThreadId: "codex-1" }, [], []).slice(-3),
    ["resume", "codex-1", "-"],
  );
  assert.equal(backend.needsCwd, false);
  assert.equal(backend.spawnGapMs, 0);
  // 契约要求 createNormalizer() 返回归一化函数；codex 无状态，每次返回同一个
  assert.equal(typeof backend.createNormalizer(), "function");
});

test("codex adapter normalizes events into the shared schema", () => {
  const { normalizeEvent } = resolveAgentBackend("codex");
  assert.deepEqual(normalizeEvent({ type: "thread.started", thread_id: "t-1" }), {
    kind: "thread.started",
    threadId: "t-1",
  });
  const message = normalizeEvent({
    type: "item.completed",
    item: { type: "agent_message", text: "hello" },
  });
  assert.equal(message.kind, "event");
  assert.equal(message.role, "assistant");
  assert.equal(message.content, "hello");
  assert.equal(normalizeEvent({ type: "item.completed", item: { type: "reasoning", text: "x" } }), null);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/agent-backend-codex.test.mjs`
预期：FAIL，`Cannot find module '.../server/agent-backends/index.mjs'`

- [ ] **步骤 3：创建 registry**

创建 `server/agent-backends/index.mjs`：

```js
import { codexBackend } from "./codex.mjs";
import { duccBackend } from "./ducc.mjs";

export const DEFAULT_AGENT_BACKEND = "ducc";

const AGENT_BACKENDS = new Map([
  [codexBackend.id, codexBackend],
  [duccBackend.id, duccBackend],
]);

export function agentBackendIds() {
  return [...AGENT_BACKENDS.keys()];
}

// 未知 id 落回默认后端而不是抛错：settings 里可能残留旧值，
// 抛错会让整个 server 起不来，落回只是换个后端跑。
export function resolveAgentBackend(id) {
  return AGENT_BACKENDS.get(id) ?? AGENT_BACKENDS.get(DEFAULT_AGENT_BACKEND);
}
```

- [ ] **步骤 4：创建 ducc.mjs 占位导出让 import 成立**

创建 `server/agent-backends/ducc.mjs`，本步只写最小可 import 的骨架（任务 6-8 逐步填实）：

```js
export const duccBackend = {
  id: "ducc",
  needsCwd: true,
  // bin/ducc:26-27 每次启动都 sed -i 同一份 settings.json，
  // 并发启动会撞写 → spawn 之间必须错开
  spawnGapMs: 500,
};
```

- [ ] **步骤 5：运行测试验证通过**

运行：`node --test test/agent-backend-codex.test.mjs`
预期：PASS，`# pass 3`

- [ ] **步骤 6：Commit**

```bash
git add server/agent-backends/index.mjs server/agent-backends/ducc.mjs test/agent-backend-codex.test.mjs
git commit -m "feat(ai): add the agent backend registry"
```

---

## 任务 6：ducc adapter —— `resolveExecutable` 与 `buildArgs`

**文件：**
- 修改：`server/agent-backends/ducc.mjs`
- 测试：`test/agent-backend-ducc.test.mjs`（创建）

- [ ] **步骤 1：编写失败的测试**

创建 `test/agent-backend-ducc.test.mjs`：

```js
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { duccBackend } from "../server/agent-backends/ducc.mjs";

const THREAD = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  origin: { workspacePath: "/ws" },
  sandbox: "workspace-write",
  model: "Opus 5",
  reasoningEffort: "high",
  codexThreadId: null,
};

test("ducc buildArgs pins the session id and keeps the prompt off argv", () => {
  assert.deepEqual(duccBackend.buildArgs(THREAD, ["/other"], []), [
    "-p", "--output-format", "stream-json", "--verbose",
    "--session-id", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "--permission-mode", "acceptEdits",
    "--add-dir", "/other",
    "--model", "Opus 5",
    "--effort", "high",
  ]);
  assert.equal(duccBackend.needsCwd, true);
  assert.equal(duccBackend.spawnGapMs, 500);
});

test("ducc buildArgs resumes by session id instead of pinning a new one", () => {
  const args = duccBackend.buildArgs(
    { ...THREAD, codexThreadId: "11111111-2222-3333-4444-555555555555" }, [], [],
  );
  assert.equal(args.includes("--session-id"), false);
  assert.deepEqual(args.slice(4, 6), ["--resume", "11111111-2222-3333-4444-555555555555"]);
});

test("ducc buildArgs omits a non-uuid session id", () => {
  const args = duccBackend.buildArgs({ ...THREAD, id: "not-a-uuid" }, [], []);
  assert.equal(args.includes("--session-id"), false);
});

test("ducc buildArgs maps sandbox onto permission modes", () => {
  const readOnly = duccBackend.buildArgs({ ...THREAD, sandbox: "read-only" }, [], []);
  assert.deepEqual(readOnly.slice(6, 10), [
    "--permission-mode", "default", "--disallowedTools", "Write,Edit,NotebookEdit",
  ]);
  const danger = duccBackend.buildArgs({ ...THREAD, sandbox: "danger-full-access" }, [], []);
  assert.deepEqual(danger.slice(6, 8), ["--permission-mode", "bypassPermissions"]);
});

test("ducc resolveExecutable prefers DUCC_EXECUTABLE, then PATH", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ducc-bin-"));
  try {
    const binDirectory = path.join(directory, "bin");
    await mkdir(binDirectory);
    const onPath = path.join(binDirectory, "ducc");
    await writeFile(onPath, "#!/bin/sh\nexit 0\n");
    await chmod(onPath, 0o755);

    assert.equal(
      duccBackend.resolveExecutable({ env: { DUCC_EXECUTABLE: " /explicit/ducc " } }),
      "/explicit/ducc",
    );
    assert.equal(duccBackend.resolveExecutable({ env: { PATH: binDirectory } }), onPath);
    assert.equal(duccBackend.resolveExecutable({ env: { PATH: "/nowhere-zzz" } }), "ducc");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/agent-backend-ducc.test.mjs`
预期：FAIL，`duccBackend.buildArgs is not a function`

- [ ] **步骤 3：实现 `buildArgs` 与 `resolveExecutable`**

把 `server/agent-backends/ducc.mjs` 整个文件替换为：

```js
import { accessSync, constants } from "node:fs";
import path from "node:path";

import { buildCodexPrompt } from "./codex.mjs";

// sandbox → ducc 的 --permission-mode（合法取值来自 `ducc --help`：
// acceptEdits / bypassPermissions / default / dontAsk / plan / auto）
const PERMISSION_MODES = {
  "read-only": "default",
  "workspace-write": "acceptEdits",
  "danger-full-access": "bypassPermissions",
};
// read-only 在 codex 侧是靠 approvals reviewer 拦，ducc 侧直接禁掉三个写工具
const READ_ONLY_DENIED_TOOLS = "Write,Edit,NotebookEdit";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildDuccArgs(thread, addDirectories, imagePaths = []) {
  // imagePaths 故意不用：ducc 没有 codex 的 -i，图片路径已经由
  // buildCodexPrompt 写进 <taskboard_context> 的 turn_attachment_paths
  void imagePaths;
  // prompt 走 stdin（实测 `printf ... | ducc -p` 成立），不进 argv
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (thread.codexThreadId) {
    args.push("--resume", thread.codexThreadId);
  } else if (UUID_PATTERN.test(thread.id)) {
    // ducc 支持预先指定会话 id，直接复用 ai_chat_threads.id
    args.push("--session-id", thread.id);
  }
  args.push("--permission-mode", PERMISSION_MODES[thread.sandbox] ?? "acceptEdits");
  if (thread.sandbox === "read-only") {
    args.push("--disallowedTools", READ_ONLY_DENIED_TOOLS);
  }
  for (const directory of addDirectories) args.push("--add-dir", directory);
  if (thread.model) args.push("--model", thread.model);
  if (thread.reasoningEffort) args.push("--effort", thread.reasoningEffort);
  return args;
}

function executableOnPath(env) {
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "ducc");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 继续找下一个 PATH 条目
    }
  }
  return null;
}

export const duccBackend = {
  id: "ducc",
  // ducc 没有 codex 的 -C，工作区只能靠子进程 cwd
  needsCwd: true,
  // bin/ducc:26-27 每次启动都 sed -i 同一份 settings.json / no-baidu-settings.json，
  // 并发启动会撞写。这是外部脚本的缺陷，改不了，只能错开。
  spawnGapMs: 500,
  resolveExecutable: ({ env = process.env } = {}) => {
    const explicit = env.DUCC_EXECUTABLE;
    if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
    return executableOnPath(env) ?? "ducc";
  },
  buildArgs: buildDuccArgs,
  // prompt 格式（skill 引用替换 + <taskboard_context> + <user_message>）与后端无关
  buildPrompt: buildCodexPrompt,
};
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/agent-backend-ducc.test.mjs test/agent-backend-codex.test.mjs`
预期：全 PASS，`# pass 8`

- [ ] **步骤 5：Commit**

```bash
git add server/agent-backends/ducc.mjs test/agent-backend-ducc.test.mjs
git commit -m "feat(ai): build ducc argv with a pinned session id"
```

---

## 任务 7：ducc `normalizeEvent`（有状态，按 tool_use_id 关联）

**文件：**
- 修改：`server/agent-backends/ducc.mjs`
- 修改：`server/agent-backends/codex.mjs`（`cappedText`/`detailText` 改成导出；`normalizeEvent` 字段换成 `createNormalizer`）
- 修改：`test/agent-backend-ducc.test.mjs`（追加断言）
- 修改：`test/agent-backend-codex.test.mjs`（跟着契约改一行取值）

**为什么必须有状态** —— 这一条决定了整个任务的形状，先读完再动手：

`web/src/aiChatState.ts:168-185` 的 `filterVisibleAiEvents` 做两件事：

1. 按 `type` 过滤，白名单是 `VISIBLE_EVENT_TYPES`（138-155 行）。`tool_result` **不在里面**
2. 同一个 `data.itemId` 的活动事件**只保留最后一条**（`latestActivityIndex.get(itemId) === index`）

所以 ducc 的 `tool_result` 必须：(a) 用一个白名单里的 `type`；(b) 用**与它对应的 `tool_use` 相同的** `type`，否则后到的那条会把前面的命令卡片顶掉、类型还变了；(c) 自带完整内容（命令原文 + 输出），因为只有它会被渲染。

而 `tool_result` 事件里**只有 `tool_use_id`，没有工具名**。要知道类型只能记住先前的 `tool_use`。因此本任务给 backend 契约加一个 `createNormalizer()`：codex 返回它那个无状态函数，ducc 返回一个带 `Map` 的闭包。每个 turn 调一次。

- [ ] **步骤 1：把断言追加到 `test/agent-backend-ducc.test.mjs` 末尾**

```js
const INIT_EVENT = {
  type: "system",
  subtype: "init",
  cwd: "/tmp/ws",
  session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  model: "Opus 5",
  permissionMode: "acceptEdits",
  claude_code_version: "2.1.76",
};

test("ducc normalizer maps system/init to thread.started and drops hook noise", () => {
  const normalize = duccBackend.createNormalizer();
  assert.deepEqual(normalize(INIT_EVENT), {
    kind: "thread.started",
    threadId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  });
  assert.equal(normalize({ type: "system", subtype: "hook_started" }), null);
  assert.equal(normalize({ type: "system", subtype: "hook_response", exit_code: 0 }), null);
  assert.equal(normalize({ type: "system", subtype: "init" }), null);
  assert.equal(normalize(null), null);
  assert.equal(normalize([]), null);
});

test("ducc normalizer splits one assistant message into per-block events", () => {
  const normalize = duccBackend.createNormalizer();
  const events = normalize({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "先看文件" },
        { type: "thinking", thinking: "内部推理，不入库" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/ws/a.txt" } },
        { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls -l" } },
      ],
    },
    session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  });
  assert.equal(events.length, 3);
  assert.deepEqual(events[0], {
    kind: "event",
    type: "agent_message",
    role: "assistant",
    content: "先看文件",
    data: { status: "completed" },
  });
  assert.deepEqual(events[1], {
    kind: "event",
    type: "mcp_tool_call",
    role: "activity",
    content: "Read",
    data: {
      status: "started",
      itemId: "toolu_1",
      tool: "Read",
      detail: JSON.stringify({ arguments: { file_path: "/tmp/ws/a.txt" } }),
    },
  });
  assert.deepEqual(events[2], {
    kind: "event",
    type: "command_execution",
    role: "activity",
    content: "ls -l",
    data: { status: "started", itemId: "toolu_2", command: "ls -l" },
  });
});
```

```js
test("ducc normalizer replays the tool_use type on its tool_result", () => {
  const normalize = duccBackend.createNormalizer();
  normalize({
    type: "assistant",
    message: { content: [
      { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls -l" } },
    ] },
  });
  const [result] = normalize({
    type: "user",
    message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_2", content: "total 0\n" },
    ] },
  });
  // type 必须与 tool_use 那条一致，否则 filterVisibleAiEvents 的 itemId 去重会换掉卡片类型
  assert.deepEqual(result, {
    kind: "event",
    type: "command_execution",
    role: "activity",
    content: "ls -l",
    data: { status: "completed", itemId: "toolu_2", command: "ls -l", output: "total 0\n" },
  });
});

test("ducc normalizer maps write tools onto file_change", () => {
  const normalize = duccBackend.createNormalizer();
  const [started] = normalize({
    type: "assistant",
    message: { content: [
      { type: "tool_use", id: "toolu_3", name: "Edit",
        input: { file_path: "/tmp/ws/b.txt", old_string: "a", new_string: "b" } },
    ] },
  });
  assert.deepEqual(started, {
    kind: "event",
    type: "file_change",
    role: "activity",
    content: "/tmp/ws/b.txt",
    data: { status: "started", itemId: "toolu_3", files: ["/tmp/ws/b.txt"] },
  });
});

test("ducc normalizer marks a failed tool_result as an error", () => {
  const normalize = duccBackend.createNormalizer();
  // 没见过对应的 tool_use（比如 resume 续上的会话）→ 落回 mcp_tool_call
  const [failed] = normalize({
    type: "user",
    message: { content: [
      { type: "tool_result", tool_use_id: "toolu_9", content: "boom", is_error: true },
    ] },
  });
  assert.equal(failed.type, "mcp_tool_call");
  assert.equal(failed.role, "error");
  assert.equal(failed.data.status, "failed");
  assert.equal(failed.data.detail, JSON.stringify({ result: "boom" }));
});

test("ducc normalizer ignores a user turn that carries no tool_result", () => {
  const normalize = duccBackend.createNormalizer();
  assert.equal(normalize({ type: "user", message: { content: "纯文本回声" } }), null);
});
```

```js
test("ducc normalizer turns the result event into a terminal outcome", () => {
  const normalize = duccBackend.createNormalizer();
  assert.deepEqual(normalize({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "hello",
    usage: { input_tokens: 94529, cache_read_input_tokens: 12, output_tokens: 19 },
  }), {
    kind: "event",
    type: "turn.completed",
    role: "activity",
    // 终态不重复正文：result 里那段文字前面已经作为 assistant text 块入过库
    content: "",
    data: {
      status: "completed",
      usage: { input_tokens: 94529, cached_input_tokens: 12, output_tokens: 19 },
    },
    outcome: "completed",
  });
});

test("ducc normalizer reports a failed result as turn.failed", () => {
  const normalize = duccBackend.createNormalizer();
  assert.deepEqual(normalize({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "配额用尽",
  }), {
    kind: "event",
    type: "turn.failed",
    role: "error",
    content: "配额用尽",
    data: { status: "failed" },
    outcome: "failed",
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/agent-backend-ducc.test.mjs`
预期：FAIL，`TypeError: duccBackend.createNormalizer is not a function`（前 5 个 argv 用例仍 PASS）

- [ ] **步骤 3：把 `cappedText` / `detailText` 改成导出**

在 `server/agent-backends/codex.mjs` 里改两处声明（任务 4 搬过去的那份），只加 `export`：

```js
export function cappedText(value) {
  return typeof value === "string" ? value.slice(0, VISIBLE_TEXT_LIMIT) : "";
}
```

```js
export function detailText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return cappedText(value);
  try {
    return cappedText(JSON.stringify(value));
  } catch {
    return "";
  }
}
```

同时把 codex adapter 对象里的这一行：

```js
  normalizeEvent: normalizeCodexEvent,
```

换成工厂形式，让两个后端只有一个契约字段：

```js
  // codex 的归一化本来就无状态；包一层工厂只是为了和 ducc 共用同一个契约
  createNormalizer: () => normalizeCodexEvent,
```

`normalizeCodexEvent` 仍然是 `codex.mjs` 的导出函数（`ai-chat-process.mjs` 的 re-export 和 `test/ai-chat-runner.test.mjs` 都还在用），只是不再挂在 adapter 对象上。

跟着改任务 5 那个测试的取值方式，`test/agent-backend-codex.test.mjs` 里：

```js
  const normalizeEvent = resolveAgentBackend("codex").createNormalizer();
```

- [ ] **步骤 4：在 `server/agent-backends/ducc.mjs` 里实现归一化**

第一处，把顶部那行 import 换成（多取两个文本工具）：

```js
import { buildCodexPrompt, cappedText, detailText } from "./codex.mjs";
```

第二处，在 `executableOnPath` 之前插入下面这一整段：

```js
// ducc 的工具名 → 已有的 7 个 ITEM_TYPES 之一。落在白名单里前端才渲染
//（web/src/aiChatState.ts:138-155），所以这里不引入任何新 type。
const TOOL_EVENT_TYPES = new Map([
  ["Bash", "command_execution"],
  ["Edit", "file_change"],
  ["Write", "file_change"],
  ["NotebookEdit", "file_change"],
  ["WebSearch", "web_search"],
  ["WebFetch", "web_search"],
  ["TodoWrite", "todo_list"],
]);

// 一个 tool_use 块 → { type, content, data }。tool_result 复用同一份 type/content。
function toolFacets(name, input) {
  const type = TOOL_EVENT_TYPES.get(name) ?? "mcp_tool_call";

  if (type === "command_execution") {
    const command = cappedText(input?.command);
    return { type, content: command, data: command ? { command } : {} };
  }

  if (type === "file_change") {
    const file = cappedText(input?.file_path ?? input?.notebook_path);
    return { type, content: file, data: file ? { files: [file] } : {} };
  }

  if (type === "web_search") {
    const query = cappedText(input?.query ?? input?.url);
    return { type, content: query, data: query ? { query } : {} };
  }

  if (type === "todo_list") {
    const items = Array.isArray(input?.todos)
      ? input.todos.map((todo) => ({
          text: cappedText(todo?.content ?? todo?.subject),
          ...(typeof todo?.status === "string"
            ? { completed: todo.status === "completed" }
            : {}),
        })).filter((todo) => todo.text)
      : [];
    return {
      type,
      content: cappedText(items.map((todo) => todo.text).join("\n")),
      data: items.length > 0 ? { detail: detailText(items) } : {},
    };
  }

  const tool = cappedText(name);
  return {
    type,
    content: tool,
    data: {
      ...(tool ? { tool } : {}),
      ...(input === undefined ? {} : { detail: detailText({ arguments: input }) }),
    },
  };
}
```

第三处，紧接着上一段再插入：

```js
// tool_result 的 content 可能是字符串，也可能是 [{type:"text",text}]
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function resultData(pending, output) {
  const type = pending?.type ?? "mcp_tool_call";
  if (type === "command_execution") {
    return { ...pending.data, ...(output ? { output } : {}) };
  }
  if (type === "mcp_tool_call") {
    return {
      ...(pending?.data?.tool ? { tool: pending.data.tool } : {}),
      detail: detailText({
        ...(pending?.input === undefined ? {} : { arguments: pending.input }),
        result: output,
      }),
    };
  }
  return { ...(pending?.data ?? {}) };
}

function usageData(usage) {
  const pairs = [
    ["input_tokens", usage?.input_tokens],
    ["cached_input_tokens", usage?.cache_read_input_tokens],
    ["output_tokens", usage?.output_tokens],
  ];
  const normalized = {};
  for (const [key, value] of pairs) {
    if (Number.isFinite(value)) normalized[key] = value;
  }
  return normalized;
}

function terminalEvent(raw) {
  const failed = raw.is_error === true || raw.subtype !== "success";
  if (failed) {
    return {
      kind: "event",
      type: "turn.failed",
      role: "error",
      content: cappedText(raw.result) || "ducc turn failed",
      data: { status: "failed" },
      outcome: "failed",
    };
  }
  const usage = usageData(raw.usage);
  return {
    kind: "event",
    type: "turn.completed",
    role: "activity",
    content: "",
    data: {
      status: "completed",
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
    },
    outcome: "completed",
  };
}
```

第四处，再接着插入工厂本体：

```js
export function createDuccNormalizer() {
  // tool_use_id → { type, content, data, input }。tool_result 里没有工具名，
  // 只能靠这张表把 type 还原成和 tool_use 那条一致。
  const pendingTools = new Map();

  function blockEvents(blocks) {
    const events = [];
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block?.type === "text") {
        const content = cappedText(block.text);
        if (!content) continue;
        events.push({
          kind: "event",
          type: "agent_message",
          role: "assistant",
          content,
          data: { status: "completed" },
        });
        continue;
      }

      if (block?.type === "tool_use") {
        const itemId = cappedText(block.id);
        const facets = toolFacets(block.name, block.input);
        if (itemId) pendingTools.set(itemId, { ...facets, input: block.input });
        events.push({
          kind: "event",
          type: facets.type,
          role: "activity",
          content: facets.content,
          data: { status: "started", ...(itemId ? { itemId } : {}), ...facets.data },
        });
        continue;
      }

      if (block?.type === "tool_result") {
        const itemId = cappedText(block.tool_use_id);
        const pending = pendingTools.get(itemId);
        pendingTools.delete(itemId);
        const output = cappedText(resultText(block.content));
        const failed = block.is_error === true;
        events.push({
          kind: "event",
          type: pending?.type ?? "mcp_tool_call",
          role: failed ? "error" : "activity",
          content: pending?.content ?? "",
          data: {
            status: failed ? "failed" : "completed",
            ...(itemId ? { itemId } : {}),
            ...resultData(pending, output),
          },
        });
      }
      // thinking / 其他块类型：不入库
    }
    return events;
  }

  return function normalizeDuccEvent(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

    if (raw.type === "system") {
      // hook_started / hook_response 是 SessionStart 钩子的噪声，只要 init
      if (raw.subtype !== "init") return null;
      if (
        typeof raw.session_id !== "string"
        || raw.session_id.length === 0
        || raw.session_id.length > 256
        || raw.session_id.includes("\0")
      ) {
        return null;
      }
      return { kind: "thread.started", threadId: raw.session_id };
    }

    if (raw.type === "assistant" || raw.type === "user") {
      const events = blockEvents(raw.message?.content);
      return events.length > 0 ? events : null;
    }

    if (raw.type === "result") return terminalEvent(raw);

    return null;
  };
}
```

第五处，在 `duccBackend` 对象里 `buildPrompt` 那行下面补一行：

```js
  createNormalizer: createDuccNormalizer,
```

- [ ] **步骤 5：运行测试验证通过**

运行：`node --test test/agent-backend-ducc.test.mjs test/agent-backend-codex.test.mjs`
预期：全 PASS，`# pass 16`（ducc 13 + codex 3）

- [ ] **步骤 6：回归已有测试**

运行：`node --test test/ai-chat-runner.test.mjs test/ai-chat-database.test.mjs`
预期：全 PASS —— 证明把 `normalizeEvent` 从 adapter 对象上摘掉没有影响 `normalizeCodexEvent` 的既有导入路径。

- [ ] **步骤 7：Commit**

```bash
git add server/agent-backends/ducc.mjs server/agent-backends/codex.mjs \
  test/agent-backend-ducc.test.mjs test/agent-backend-codex.test.mjs
git commit -m "feat(ai): normalize ducc stream-json into the shared event schema"
```

---

## 任务 8：ducc `discoverCatalog`

**文件：**
- 修改：`server/agent-backends/ducc.mjs`
- 创建：`test/agent-backend-ducc-catalog.test.mjs`

**背景（规格 §5.2 的两处实测偏离）：** `ducc models` 输出的是纯文本而非 JSON，格式固定为一行 `Available Models:` 后跟一行逗号分隔的名字（含空格与中文，例如 `Claude Opus 4.6`、`GLM-5.2-内部`）。skill 列表不能用 init 事件里的 `skills`——(a) catalog 在 spawn 之前就要用；(b) 那里只有名字没有路径，而 `buildCodexPrompt` 生成的 `[$id](path)` 引用必须带路径。所以扫文件系统。

`AiChatService.#resolveModel`（`server/ai-chat.mjs:~430`）把 `catalog.models[0]` 当默认模型，所以排序必须把 `Opus 5` 顶到第一位。

- [ ] **步骤 1：写失败的测试**

创建 `test/agent-backend-ducc-catalog.test.mjs`：

```js
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { duccBackend } from "../server/agent-backends/ducc.mjs";

const MODELS_OUTPUT = "Available Models:\nauto, GLM-5, Claude Opus 4.6, Opus 5, Fable 5\n";

async function writeSkill(root, name, description) {
  const directory = path.join(root, ".claude", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
  return path.join(directory, "SKILL.md");
}

test("ducc discoverCatalog parses `ducc models` text and scans SKILL.md", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-ducc-catalog-"));
  try {
    const executable = path.join(root, "fake-ducc");
    await writeFile(executable, `#!/bin/sh\nprintf '%s' '${MODELS_OUTPUT}'\n`);
    await chmod(executable, 0o755);

    const workspacePath = path.join(root, "ws");
    const home = path.join(root, "home");
    await mkdir(workspacePath);
    const repoSkillPath = await writeSkill(workspacePath, "manage-taskboard", "看板任务操作");
    await writeSkill(home, "humanizer", "去掉 AI 味");

    const catalog = await duccBackend.discoverCatalog({
      executable,
      workspacePath,
      processEnv: { ...process.env, HOME: home },
    });

    assert.equal(catalog.models[0].slug, "Opus 5");
    assert.deepEqual(catalog.models[0].supportedReasoningEfforts, ["low", "medium", "high", "max"]);
    assert.equal(catalog.models[0].defaultReasoningEffort, "medium");
    assert.equal(catalog.models.length, 5);
    assert.deepEqual(catalog.sandboxes, ["read-only", "workspace-write", "danger-full-access"]);

    assert.deepEqual(catalog.skills.map((skill) => skill.id), ["humanizer", "manage-taskboard"]);
    assert.deepEqual(catalog.skills[1], {
      id: "manage-taskboard",
      label: "manage-taskboard",
      description: "看板任务操作",
      path: repoSkillPath,
      scope: "repo",
    });
    assert.equal(catalog.skills[0].scope, "user");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

```js
test("ducc discoverCatalog lets a repo skill win and tolerates missing directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-ducc-catalog-"));
  try {
    const executable = path.join(root, "fake-ducc");
    await writeFile(executable, `#!/bin/sh\nprintf '%s' '${MODELS_OUTPUT}'\n`);
    await chmod(executable, 0o755);

    const workspacePath = path.join(root, "ws");
    await mkdir(workspacePath);
    const repoSkillPath = await writeSkill(workspacePath, "humanizer", "仓库版");
    const home = path.join(root, "home");
    await writeSkill(home, "humanizer", "用户版");

    const catalog = await duccBackend.discoverCatalog({
      executable,
      workspacePath,
      processEnv: { ...process.env, HOME: home },
    });
    assert.equal(catalog.skills.length, 1);
    assert.equal(catalog.skills[0].path, repoSkillPath);
    assert.equal(catalog.skills[0].scope, "repo");

    // 两个 .claude/skills 都不存在时返回空数组，不抛
    const empty = await duccBackend.discoverCatalog({
      executable,
      workspacePath: root,
      processEnv: { ...process.env, HOME: path.join(root, "nowhere") },
    });
    assert.deepEqual(empty.skills, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/agent-backend-ducc-catalog.test.mjs`
预期：FAIL，`TypeError: duccBackend.discoverCatalog is not a function`

- [ ] **步骤 3：实现 `discoverCatalog`**

`server/agent-backends/ducc.mjs` 顶部的 import 补三行（放在现有 `node:fs`/`node:path` 之后）：

```js
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

import { withoutTaskboardLauncherEnvironment } from "../../shared/codex-environment.mjs";

const execFileAsync = promisify(execFile);
```

然后在文件末尾（`duccBackend` 对象**之前**）插入这一整段：

```js
// 与 ai-chat-catalog.mjs 的 CATALOG_TIMEOUT_MS / CATALOG_MAX_BUFFER 取同一档
const CATALOG_TIMEOUT_MS = 10_000;
const CATALOG_MAX_BUFFER = 2 * 1024 * 1024;
const DUCC_EFFORTS = ["low", "medium", "high", "max"];
// #resolveModel 拿 catalog.models[0] 当默认模型，所以要把它顶到第一位
const DUCC_PREFERRED_MODEL = "Opus 5";
const DUCC_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];

// `ducc models` 输出：一行 "Available Models:"，一行逗号分隔的名字
function parseDuccModels(stdout) {
  const line = String(stdout ?? "")
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0 && !value.endsWith(":"));
  if (!line) return [];
  const slugs = [...new Set(line.split(",").map((value) => value.trim()).filter(Boolean))];
  slugs.sort((left, right) =>
    (right === DUCC_PREFERRED_MODEL ? 1 : 0) - (left === DUCC_PREFERRED_MODEL ? 1 : 0));
  return slugs.map((slug) => ({
    slug,
    displayName: slug,
    description: "",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [...DUCC_EFFORTS],
    serviceTiers: [],
  }));
}

// SKILL.md 的 YAML frontmatter 只取 description 一行；取不到就留空
function skillDescription(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) return "";
  const line = match[1].split("\n").find((value) => value.startsWith("description:"));
  return line ? cappedText(line.slice("description:".length).trim()) : "";
}

async function skillsInDirectory(root, scope) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];   // 目录不存在就是没有 skill
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(root, entry.name, "SKILL.md");
    let source;
    try {
      source = await readFile(skillPath, "utf8");
    } catch {
      continue;  // 没有 SKILL.md 的子目录不是 skill
    }
    skills.push({
      id: entry.name,
      label: entry.name,
      description: skillDescription(source),
      path: skillPath,
      scope,
    });
  }
  return skills;
}
```

紧接着再插入入口函数：

```js
export async function discoverDuccCatalog({ executable, workspacePath, processEnv = process.env }) {
  const environment = withoutTaskboardLauncherEnvironment(processEnv);
  const homeDirectory = environment.HOME || os.homedir();
  const [models, userSkills, repoSkills] = await Promise.all([
    execFileAsync(executable, ["models"], {
      cwd: workspacePath,
      env: environment,
      encoding: "utf8",
      timeout: CATALOG_TIMEOUT_MS,
      maxBuffer: CATALOG_MAX_BUFFER,
    }).then((result) => parseDuccModels(result.stdout)).catch(() => []),
    skillsInDirectory(path.join(homeDirectory, ".claude", "skills"), "user"),
    skillsInDirectory(path.join(workspacePath, ".claude", "skills"), "repo"),
  ]);

  // 同名时仓库级覆盖用户级（与 ducc 自己的加载优先级一致）
  const unique = new Map();
  for (const skill of [...userSkills, ...repoSkills]) unique.set(skill.id, skill);

  return {
    models,
    skills: [...unique.values()].sort((left, right) => left.label.localeCompare(right.label)),
    sandboxes: [...DUCC_SANDBOXES],
  };
}
```

最后在 `duccBackend` 对象里 `createNormalizer` 那行下面补一行：

```js
  discoverCatalog: discoverDuccCatalog,
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/agent-backend-ducc-catalog.test.mjs`
预期：2 个用例全 PASS

- [ ] **步骤 5：Commit**

```bash
git add server/agent-backends/ducc.mjs test/agent-backend-ducc-catalog.test.mjs
git commit -m "feat(ai): discover the ducc model and skill catalog"
```

---

## 任务 9：`AiChatService` 改走 adapter（全局切换真正生效）

这是整个计划的收口任务：前 8 个任务都只是在旁边搭零件，`ai-chat.mjs` 一行没动，所以把 `agent_backend` 设成 `ducc` 也不会有任何效果。本任务把 spawn 路径切过去。

两处要额外注意：

1. **读取发生在每次 spawn 的那一刻**（规格 §5.3），不在 constructor 里缓存 —— 改完下一个 turn 就生效，不用重启。
2. **默认值 `ducc` 会把现有 codex 集成测试全打红**：`test/ai-chat-runner.test.mjs:148` 和 `test/ai-chat-server.test.mjs:43` 都是造一个假 codex 可执行文件再构造服务，从来没写过 `agent_backend`。所以本任务给 `AiChatService` 加一个 `agentBackendId` 选项作最高优先级覆盖，两个 fixture 各加一行 `agentBackendId: "codex"`。这不只是给测试开的后门 —— `server/app.mjs` 也透传它，宿主启动时可以强制后端。

**文件：**
- 修改：`server/ai-chat.mjs:1-12`（imports）、`:48-54`（constructor）、`:121-127`（`#catalogForWorkspace`）、`:145-156`（`createThread`）、`:266-336`（`startTurn` 的 spawn 段）
- 修改：`server/agent-backends/codex.mjs`（三个终态分支加 `outcome` 字段）
- 修改：`server/app.mjs:1313-1333`（`resolveServerOptions` 透传 `agentBackendId`）、`:1515-1522`（构造 `AiChatService` 时带上）
- 修改：`test/ai-chat-runner.test.mjs:148-164`、`test/ai-chat-server.test.mjs:43-48`（两个 fixture 强制 codex）
- 测试：`test/agent-backend-switch.test.mjs`（创建）

- [ ] **步骤 1：编写失败的测试（前半：fixture）**

创建 `test/agent-backend-switch.test.mjs`：

```js
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
```

接着在同一个文件里追加 `createFixture`：

```js
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
      PATH: "/nowhere-zzz",
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
```

- [ ] **步骤 2：编写失败的测试（后半：用例）**

在 `test/agent-backend-switch.test.mjs` 末尾追加：

```js
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
```

第二个用例只需要「选中的后端确实换了」这一个信号。假 ducc 不认 `debug models`，会走 `exit 0` 之外的分支把 stdout 写成 stream-json 而不是 codex 的模型 JSON，于是 codex 的 `discoverCatalog` 解析失败抛错 —— 这个 reject 本身就是「选中了 codex」的证据。

- [ ] **步骤 3：运行测试验证失败**

运行：`node --test test/agent-backend-switch.test.mjs`
预期：FAIL，第一个用例报 `thread.backend` 是 `undefined`（`createThread` 还没写 `backend`），或直接卡在 `spawnCodexTurn` 用 `this.codexExecutable`（`undefined`）spawn 失败

- [ ] **步骤 4：改 `server/ai-chat.mjs` 的 imports 与 constructor**

把第 6-12 行的三段 import 替换为：

```js
import { resolveAiWorkspace } from "./ai-chat-catalog.mjs";
import { spawnCodexTurn } from "./ai-chat-process.mjs";
import { DEFAULT_AGENT_BACKEND, resolveAgentBackend } from "./agent-backends/index.mjs";
```

在第 50 行 `this.codexExecutable = options.codexExecutable;` 下面插入一行：

```js
    // 最高优先级的后端覆盖（宿主启动参数 / 测试 fixture）；不传则看环境变量与 settings
    this.agentBackendId = options.agentBackendId;
```

- [ ] **步骤 5：加 `#backend()` / `#executableFor()`，改 `#catalogForWorkspace` 与 `createThread`**

把第 121-127 行的 `#catalogForWorkspace` 整段替换为：

```js
  #backend() {
    // 每次调用都重新读，不缓存：改完设置下一个 turn 就生效（规格 §5.3）
    const id = this.agentBackendId
      ?? this.processEnv.TASKBOARD_AGENT_BACKEND
      ?? this.database.getSetting("agent_backend")
      ?? DEFAULT_AGENT_BACKEND;
    return resolveAgentBackend(id);
  }

  #executableFor(backend) {
    // codex 的路径已由 app.mjs 的 resolveCodexExecutable 解析过（含 .app bundle 分支），
    // 继续用那个结果，行为与改造前完全一致
    if (backend.id === "codex" && this.codexExecutable) return this.codexExecutable;
    return backend.resolveExecutable({ env: this.processEnv });
  }

  async #catalogForWorkspace(workspacePath) {
    const backend = this.#backend();
    return backend.discoverCatalog({
      executable: this.#executableFor(backend),
      workspacePath,
      processEnv: this.processEnv,
    });
  }
```

在第 145-156 行 `createAiChatThread` 的入参里，`model: model.slug,` 上面插入一行：

```js
      backend: this.#backend().id,
```

- [ ] **步骤 6：改 `startTurn` 的 args/prompt 两行**

把第 266-275 行替换为：

```js
      const backend = this.#backend();
      const args = backend.buildArgs(thread, resolved.addDirectories, imagePaths);
      const prompt = backend.buildPrompt(
        thread,
        {
          message: input.message,
          skills: selectedSkills,
          attachmentPaths,
        },
        this.manageTaskboardSkillPath,
      );
```

- [ ] **步骤 7：改 `startTurn` 的 spawn 段**

把第 297-336 行（`const resumingThreadId` 到 `});`）替换为：

```js
      const resumingThreadId = thread.codexThreadId;
      let startedThreadId = null;
      let terminalOutcome = null;
      let terminalError = "";
      // 每个 turn 一个 normalizer 实例：ducc 那个要在 turn 内攒 tool_use → tool_result 的状态
      const normalize = backend.createNormalizer();
      const handleNormalized = (normalized) => {
        if (normalized.kind === "thread.started") {
          if (
            (resumingThreadId && normalized.threadId !== resumingThreadId)
            || (startedThreadId && normalized.threadId !== startedThreadId)
          ) {
            throw new Error("The agent backend returned an unexpected session id");
          }
          startedThreadId = normalized.threadId;
          this.database.updateAiChatThread(threadId, { codexThreadId: normalized.threadId });
          return;
        }
        const event = this.database.insertAiChatEvent({
          threadId,
          runId: run.id,
          type: normalized.type,
          role: normalized.role,
          content: normalized.content,
          data: normalized.data,
        });
        // 终态由 adapter 用 outcome 声明，不再嗅探后端私有的 raw.type
        if (normalized.outcome === "completed" && terminalOutcome === null) {
          terminalOutcome = "completed";
        } else if (normalized.outcome === "failed") {
          terminalOutcome = "failed";
          terminalError ||= normalized.content;
        }
        this.#emit(threadId, { type: "ai.event", event });
      };
      const { child, completion } = spawnCodexTurn({
        executable: this.#executableFor(backend),
        args,
        prompt,
        env: this.processEnv,
        cwd: backend.needsCwd ? resolved.workspacePath : undefined,
        onRawEvent: (raw) => {
          const normalized = normalize(raw);
          if (!normalized) return;
          // ducc 的一条 assistant 消息可能拆出多个 content block
          for (const item of Array.isArray(normalized) ? normalized : [normalized]) {
            handleNormalized(item);
          }
        },
      });
```

- [ ] **步骤 8：codex adapter 的三个终态分支补 `outcome`**

在 `server/agent-backends/codex.mjs` 的 `normalizeCodexEvent` 里：

`turn.completed` 分支（`role: "activity",` 那行下面）加一行：

```js
      outcome: "completed",
```

`turn.failed` 与 `error` 两个分支（各自 `role: "error",` 那行下面）各加一行：

```js
      outcome: "failed",
```

在 `test/agent-backend-codex.test.mjs` 的 `codex adapter normalizes events into the shared schema` 用例末尾追加：

```js
  assert.equal(normalizeEvent({ type: "turn.completed", usage: {} }).outcome, "completed");
  assert.equal(normalizeEvent({ type: "turn.failed", error: "boom" }).outcome, "failed");
  assert.equal(normalizeEvent({ type: "error", message: "boom" }).outcome, "failed");
```

- [ ] **步骤 9：两个 codex fixture 显式钉住后端**

`test/ai-chat-runner.test.mjs`，在第 150 行 `codexExecutable: executable,` 上面插入一行：

```js
    agentBackendId: "codex",
```

`test/ai-chat-server.test.mjs`，在第 45 行 `codexExecutable,` 上面插入一行：

```js
    agentBackendId: "codex",
```

- [ ] **步骤 10：`server/app.mjs` 透传 `agentBackendId`**

在 `resolveServerOptions` 的返回对象里（第 1323 行 `codexExecutable:` 上面）插入一行：

```js
    agentBackendId: options.agentBackendId,
```

在第 1515-1522 行构造 `AiChatService` 时，`codexExecutable:` 上面插入一行：

```js
    agentBackendId: resolved.agentBackendId,
```

- [ ] **步骤 11：运行新测试验证通过**

运行：`node --test test/agent-backend-switch.test.mjs`
预期：2 个用例全 PASS

- [ ] **步骤 12：跑全量回归**

运行：`npm test`
预期：全 PASS。这一步不能省 —— 本任务改的是所有 AI 对话的公共路径，`test/ai-chat-runner.test.mjs`（8 个集成用例）和 `test/ai-chat-server.test.mjs` 是唯一能证明 codex 行为没被改坏的东西。若 `ai-chat-runner` 报 spawn 失败，先确认步骤 9 那行 `agentBackendId: "codex"` 加对了位置。

- [ ] **步骤 13：Commit**

```bash
git add server/ai-chat.mjs server/agent-backends/codex.mjs server/app.mjs \
  test/agent-backend-switch.test.mjs test/agent-backend-codex.test.mjs \
  test/ai-chat-runner.test.mjs test/ai-chat-server.test.mjs
git commit -m "feat(ai): route turns through the globally selected agent backend"
```

---

## 任务 10：后端不同就不 resume（规格 §5.4）

`codex_thread_id` 存的是后端私有的会话 id。ducc 认不了 codex 的 id，反之亦然。不加这道判断，切换后点开旧对话继续发消息就是拿一个无效 id 去 `--resume`，报错难懂。

时间线上那条说明用 `type: "agent_message"` —— `web/src/aiChatState.ts:138-157` 的白名单里没有「通知」这种类型，而 `ACTIVITY_LABELS`（`web/src/components/AiChat.tsx:565-580`）会把 `error` 渲染成「执行失败」，语义不对。用 `agent_message` 能直接渲染成一条气泡，前端零改动；`role` 写 `activity` 而不是 `assistant`，避免让后续消费者以为这句是模型说的。

**文件：**
- 修改：`server/ai-chat.mjs`（`startTurn`：`const backend` 之后、`buildArgs` 之前判断；`userEvent` 之后插说明事件）
- 测试：`test/agent-backend-switch.test.mjs`（追加第 3 个用例）

- [ ] **步骤 1：编写失败的测试**

在 `test/agent-backend-switch.test.mjs` 末尾追加：

```js
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/agent-backend-switch.test.mjs`
预期：第 3 个用例 FAIL —— argv 里带着 `--resume codex-session-1`，而且 `notice` 是 `undefined`

- [ ] **步骤 3：实现不可 resume 的判断**

在 `server/ai-chat.mjs` 的 `startTurn` 里，任务 9 步骤 6 加的 `const backend = this.#backend();` 下面插入：

```js
      // codex_thread_id 是后端私有的会话 id，换后端后 resume 一定失败（规格 §5.4）。
      // 清掉本地副本让 buildArgs 走「新会话」分支，DB 里的值由本轮 thread.started 覆盖。
      const staleBackend = thread.backend && thread.backend !== backend.id ? thread.backend : null;
      if (staleBackend) {
        thread = { ...thread, codexThreadId: null };
        this.database.updateAiChatThread(threadId, { backend: backend.id, codexThreadId: null });
      }
```

- [ ] **步骤 4：实现时间线说明**

在 `this.#emit(threadId, { type: "ai.event", event: userEvent });` 下面插入：

```js
      if (staleBackend) {
        const notice = this.database.insertAiChatEvent({
          threadId,
          runId: run.id,
          type: "agent_message",
          role: "activity",
          content: `此对话之前由 ${staleBackend} 生成，后端已切换到 ${backend.id}，`
            + "旧会话无法接续，本轮从新会话开始。",
          data: { status: "completed", backendSwitch: { from: staleBackend, to: backend.id } },
        });
        this.#emit(threadId, { type: "ai.event", event: notice });
      }
```

- [ ] **步骤 5：运行测试验证通过**

运行：`node --test test/agent-backend-switch.test.mjs`
预期：3 个用例全 PASS

- [ ] **步骤 6：Commit**

```bash
git add server/ai-chat.mjs test/agent-backend-switch.test.mjs
git commit -m "feat(ai): start a new session when the thread belongs to another backend"
```

---

## 任务 11：`GET/PATCH /api/local/ai/backend`

接口只读写 `settings` 里那个值。`agentBackendId` 那条更高优先级的覆盖是给宿主启动参数和测试 fixture 用的，接口不管它 —— 否则「我明明改了却不生效」会变成两个来源互相打。

**文件：**
- 修改：`server/app.mjs`（imports；`:1943` 的 `/api/local/ai/catalog` 之前插新路由）
- 测试：`test/ai-chat-server.test.mjs`（追加用例）

- [ ] **步骤 1：编写失败的测试**

在 `test/ai-chat-server.test.mjs` 末尾追加：

```js
test("the agent backend preference is readable and switchable over loopback", async () => {
  const fixture = await createServerFixture();
  try {
    const initial = await request(fixture.baseUrl, "/api/local/ai/backend");
    assert.equal(initial.response.status, 200);
    assert.deepEqual(initial.body, { backend: "ducc", available: ["codex", "ducc"] });

    const switched = await request(fixture.baseUrl, "/api/local/ai/backend", {
      method: "PATCH",
      body: { backend: "codex" },
    });
    assert.equal(switched.response.status, 200);
    assert.deepEqual(switched.body, { backend: "codex", available: ["codex", "ducc"] });
    assert.equal(
      (await request(fixture.baseUrl, "/api/local/ai/backend")).body.backend,
      "codex",
    );

    const unknown = await request(fixture.baseUrl, "/api/local/ai/backend", {
      method: "PATCH",
      body: { backend: "gemini-whatever" },
    });
    assert.equal(unknown.response.status, 400);
    assert.equal(unknown.body.error.code, "INVALID_FIELD");
    // 非法值不能落库
    assert.equal(
      (await request(fixture.baseUrl, "/api/local/ai/backend")).body.backend,
      "codex",
    );

    const extraField = await request(fixture.baseUrl, "/api/local/ai/backend", {
      method: "PATCH",
      body: { backend: "ducc", model: "Opus 5" },
    });
    assert.equal(extraField.response.status, 400);
    assert.equal(extraField.body.error.code, "UNKNOWN_FIELD");

    const wrongMethod = await request(fixture.baseUrl, "/api/local/ai/backend", { method: "POST" });
    assert.equal(wrongMethod.response.status, 405);
  } finally {
    await fixture.close();
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/ai-chat-server.test.mjs`
预期：新用例 FAIL，`/api/local/ai/backend` 返回 404

- [ ] **步骤 3：加 import**

在 `server/app.mjs` 的 import 段末尾追加：

```js
import { agentBackendIds, DEFAULT_AGENT_BACKEND } from "./agent-backends/index.mjs";
```

- [ ] **步骤 4：实现路由**

在 `server/app.mjs:1943` 的 `if (pathname === "/api/local/ai/catalog") {` **之前**插入：

```js
      if (pathname === "/api/local/ai/backend") {
        assertNoQuery(url.searchParams, "/api/local/ai/backend");
        const payload = () => ({
          backend: database.getSetting("agent_backend") ?? DEFAULT_AGENT_BACKEND,
          available: agentBackendIds(),
        });
        if (request.method === "GET") return sendJson(response, 200, payload());
        if (request.method === "PATCH") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["backend"]));
          if (!agentBackendIds().includes(body.backend)) {
            throw new ApiError(
              400,
              "INVALID_FIELD",
              `backend must be one of: ${agentBackendIds().join(", ")}`,
            );
          }
          database.setSetting("agent_backend", body.backend);
          return sendJson(response, 200, payload());
        }
        return methodNotAllowed(response, ["GET", "PATCH"]);
      }
```

`available` 的顺序是 `["codex", "ducc"]`，因为任务 5 的 `AGENT_BACKENDS` Map 先插 codex。测试里 `deepEqual` 依赖这个顺序，改注册顺序要同步改测试。

- [ ] **步骤 5：运行测试验证通过**

运行：`node --test test/ai-chat-server.test.mjs`
预期：全 PASS

- [ ] **步骤 6：Commit**

```bash
git add server/app.mjs test/ai-chat-server.test.mjs
git commit -m "feat(ai): expose the global agent backend setting over HTTP"
```

---

## 任务 12：切换后端后模型落回新后端默认（规格 §5.5）

`ai_chat_threads.model` 存的是后端私有的模型 slug。全局切换后，旧 thread 上那个 `gpt-5.5` 在 ducc 的 catalog 里不存在 —— 而 `server/ai-chat.mjs:421-435` 的 `#resolveModel` 对找不到的 slug 是**抛 `ApiError(400, "INVALID_MODEL")`**。也就是说不做这个任务，切换后所有旧对话一发消息就 400。

规格 §5.5 要的行为是「落回新后端的默认模型，不报错」。默认模型取 `catalog.models[0]`，同时把 `reasoningEffort` 一起落回该模型的 `defaultReasoningEffort` —— 只换模型不换推理档位会带着一个新后端不认的值继续跑。

**文件：**
- 修改：`server/ai-chat.mjs:421-435`（`#resolveModel` 改签名，不再抛）
- 修改：`server/ai-chat.mjs`（`startTurn` 里 `#resolveModel` 调用点，落库）
- 测试：`test/agent-backend-switch.test.mjs`（追加第 4 个用例）

- [ ] **步骤 1：编写失败的测试**

在 `test/agent-backend-switch.test.mjs` 末尾追加：

```js
test("a model slug the new backend does not know falls back to its default", async () => {
  const fixture = await createFixture();
  fixture.database.setSetting("agent_backend", "ducc");
  const thread = await fixture.service.createThread({ projectId: "project" });
  // 造一条「上一轮是 codex 跑的、模型是 codex 私有 slug」的历史
  fixture.database.updateAiChatThread(thread.id, {
    backend: "codex",
    model: "gpt-5.5",
    reasoningEffort: "high",
  });

  const run = await fixture.service.startTurn(thread.id, { message: "接着改" });
  await waitFor(() => fixture.service.getRun(run.id).status === "completed");

  const updated = fixture.database.getAiChatThread(thread.id);
  assert.equal(updated.model, "Opus 5");
  // ducc adapter 给每个模型的 defaultReasoningEffort 是 "medium"（任务 8），
  // 落回时会跟着模型一起写回，所以这里不是 null
  assert.equal(updated.reasoningEffort, "medium");
});
```

`FAKE_DUCC` 的 `models` 分支吐的是 `Opus 5, Fable 5`，所以新后端默认模型是 `Opus 5`；任务 6 的 ducc adapter 不产出推理档位，`defaultReasoningEffort` 是 `null`。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/agent-backend-switch.test.mjs`
预期：第 4 个用例 FAIL，`startTurn` 抛 `INVALID_MODEL`（`ApiError`，`status` 400）

- [ ] **步骤 3：改 `#resolveModel` 不抛**

把 `server/ai-chat.mjs:421-435` 的 `#resolveModel` 整体替换为：

```js
  // 找不到就落回 catalog 第一个模型（规格 §5.5）：全局切后端后，旧 thread 上存的是
  // 前一个后端私有的 slug，抛错会让所有旧对话一发消息就 400。
  #resolveModel(catalog, slug) {
    const models = catalog.models ?? [];
    if (models.length === 0) {
      throw new ApiError(500, "NO_MODELS", "The agent backend reported no available models");
    }
    return models.find((model) => model.slug === slug) ?? models[0];
  }
```

- [ ] **步骤 4：调用点落库**

`startTurn` 里 `const model = this.#resolveModel(catalog, thread.model);` 那行下面插入：

```js
      // 落回默认模型时要写回 thread，否则每轮都要重新落回一次，
      // 而且网页上显示的模型名会和实际跑的对不上
      if (model.slug !== thread.model) {
        const reasoningEffort = model.defaultReasoningEffort ?? null;
        this.database.updateAiChatThread(threadId, { model: model.slug, reasoningEffort });
        thread = { ...thread, model: model.slug, reasoningEffort };
      }
```

这里复用任务 10 步骤 3 已经把 `thread` 从 `const` 改成 `let` 的前提。若任务 10 未做，先把 `startTurn` 里 `const thread = ` 改成 `let thread = `。

- [ ] **步骤 5：运行测试验证通过**

运行：`node --test test/agent-backend-switch.test.mjs`
预期：4 个用例全 PASS

- [ ] **步骤 6：跑全量回归**

运行：`npm test`
预期：全 PASS。特别关注 `test/ai-chat-runner.test.mjs` 里断言 `INVALID_MODEL` 的用例 —— 若存在，它测的是「用户显式传了一个不存在的 slug」，那条路径应该继续报错。真有这种用例时，把校验挪到 `createThread`/`PATCH thread` 的入参处（那里的 slug 来自用户输入，报错是对的），`#resolveModel` 只负责运行时落回。

- [ ] **步骤 7：Commit**

```bash
git add server/ai-chat.mjs test/agent-backend-switch.test.mjs
git commit -m "feat(ai): fall back to the backend default model instead of failing the turn"
```

---

## 任务 13：并发启动错开 500ms（规格 §5.6）

`bin/ducc:26-27` 每次启动都对同一份 `settings.json` 和 `no-baidu-settings.json` 做 `sed -i`。两个 turn 同时起就是两个进程同时改写同一个文件，可能读到写了一半的 JSON。这是外部脚本的缺陷，我们改不了，只能避让。

`spawnGapMs` 在任务 4 的 adapter 契约里已经声明（codex 是 `0`，ducc 是 `500`）。本任务做的是真正让它生效：一个进程内的全局串行闸门，保证**同一后端**相邻两次 spawn 之间至少隔 `spawnGapMs`。

不用 `setTimeout` 直接 sleep 了就完事 —— 三个 turn 同时进来会各睡 500ms 然后一起醒，等于没错开。要的是链式排队：每次 spawn 把「下一次最早可以 spawn 的时刻」往后推。

**文件：**
- 创建：`server/agent-backends/spawn-gate.mjs`
- 创建：`test/spawn-gate.test.mjs`
- 修改：`server/ai-chat.mjs`（`spawnCodexTurn` 之前 `await`）

- [ ] **步骤 1：编写失败的测试**

创建 `test/spawn-gate.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createSpawnGate } from "../server/agent-backends/spawn-gate.mjs";

test("the gate spaces consecutive acquisitions by the requested gap", async () => {
  const gate = createSpawnGate();
  const started = Date.now();
  const stamps = [];
  await Promise.all([1, 2, 3].map(async () => {
    await gate.acquire("ducc", 60);
    stamps.push(Date.now() - started);
  }));
  stamps.sort((left, right) => left - right);
  assert.equal(stamps.length, 3);
  // 第一个立即放行，之后每个至少再等一个 gap
  assert.ok(stamps[1] - stamps[0] >= 55, `gap 1 too small: ${stamps[1] - stamps[0]}`);
  assert.ok(stamps[2] - stamps[1] >= 55, `gap 2 too small: ${stamps[2] - stamps[1]}`);
});

test("a zero gap never waits", async () => {
  const gate = createSpawnGate();
  const started = Date.now();
  await Promise.all([1, 2, 3].map(() => gate.acquire("codex", 0)));
  assert.ok(Date.now() - started < 30, "a zero gap must not introduce delay");
});

test("different backends do not block each other", async () => {
  const gate = createSpawnGate();
  await gate.acquire("ducc", 200);
  const started = Date.now();
  await gate.acquire("codex", 0);
  assert.ok(Date.now() - started < 30, "codex must not wait behind ducc");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/spawn-gate.test.mjs`
预期：3 个用例全 FAIL，报错 `Cannot find module .../server/agent-backends/spawn-gate.mjs`

- [ ] **步骤 3：实现闸门**

创建 `server/agent-backends/spawn-gate.mjs`：

```js
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 按后端 id 分别排队的启动闸门。
 * 起因：`bin/ducc:26-27` 每次启动都对同一份 settings.json 做 sed -i，
 * 并发启动会撞写（规格 §5.6）。外部脚本改不了，只能让我们自己错开。
 */
export function createSpawnGate() {
  // backend id → 下一次最早可以 spawn 的时刻（epoch ms）
  const nextAllowedAt = new Map();
  return {
    async acquire(backendId, gapMs) {
      if (!gapMs) return;
      const now = Date.now();
      const earliest = Math.max(now, nextAllowedAt.get(backendId) ?? 0);
      // 先把下一位的时刻占掉再 await，否则同一 tick 里进来的几个人会算出同一个 earliest
      nextAllowedAt.set(backendId, earliest + gapMs);
      if (earliest > now) await sleep(earliest - now);
    },
  };
}

// server 进程内共享一个：跨 thread 的 spawn 也要互相错开
export const spawnGate = createSpawnGate();
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/spawn-gate.test.mjs`
预期：3 个用例全 PASS

- [ ] **步骤 5：接进 `startTurn`**

`server/ai-chat.mjs` import 段追加：

```js
import { spawnGate } from "./agent-backends/spawn-gate.mjs";
```

在任务 9 步骤 7 写的 `const { child, completion } = spawnCodexTurn({` **之前**插入：

```js
      await spawnGate.acquire(backend.id, backend.spawnGapMs);
```

- [ ] **步骤 6：跑全量回归**

运行：`npm test`
预期：全 PASS。codex 的 `spawnGapMs` 是 `0`，`acquire` 直接 return，现有集成测试的耗时不受影响。

- [ ] **步骤 7：Commit**

```bash
git add server/agent-backends/spawn-gate.mjs server/ai-chat.mjs test/spawn-gate.test.mjs
git commit -m "feat(ai): stagger ducc launches to dodge its settings rewrite race"
```

---

## 手工验证（规格 §9.3）

假可执行文件测不到的东西，全部任务做完后按顺序手验一遍。每条都写清了预期，不满足就是有 bug，别放过。

- [ ] **1. ducc 真跑通一轮**

```bash
cd /home/work/vdc/dashi-taskboard
node -e '
const { TaskboardDatabase } = await import("./server/database.mjs");
const db = new TaskboardDatabase("./data");
db.setSetting("agent_backend", "ducc");
console.log(db.getSetting("agent_backend"));
db.close();
' --input-type=module
npm start
```

浏览器开 `http://127.0.0.1:47823`（走 VSCode 的端口转发，不要用 LAN IP —— `/api/local/ai/*` 是 loopback-only），右下角快捷对话发一句「列出当前目录下的文件」。

预期：时间线出现 assistant 气泡和工具调用；`sqlite3 data/taskboard.db 'select backend, model, codex_thread_id from ai_chat_threads order by created_at desc limit 1'` 显示 `ducc|Opus 5|<和 thread id 相同的 uuid>`。

若长时间无输出，先确认 `which ducc` 指向 `/home/work/.comate/baidu-cc/bin/ducc`；再确认那个 sh 包装脚本 unset 掉代理后模型端点仍可达（它走内网直连，正常情况下不需要代理）。

- [ ] **2. 全局切换后 catalog 真的换了模型列表**

`PATCH /api/local/ai/backend {"backend":"codex"}`，然后重新打开对话面板。

```bash
curl -s -X PATCH http://127.0.0.1:47823/api/local/ai/backend \
  -H 'content-type: application/json' -d '{"backend":"codex"}'
curl -s http://127.0.0.1:47823/api/local/ai/catalog?projectId=<你的项目id>
```

预期：模型下拉从 `Opus 5 / Fable 5` 变成 codex 的 `gpt-*` 列表，**不用重启 server**（规格 §5.3 的「读发生在每次 spawn 那一刻」）。

- [ ] **3. 切回 ducc 后旧 codex 对话不 resume**

接着第 2 步：用 codex 跑一轮，再切回 ducc，打开**同一条**对话发消息。

预期：时间线上先出现一条「此对话之前由 codex 生成，后端已切换到 ducc……」的气泡，然后正常回答；`ai_chat_threads.backend` 变成 `ducc`，`codex_thread_id` 变成一个新 uuid。

- [ ] **4. 并发不撞 ducc 的 settings 写入**

同时起两条对话各发一句话。

预期：两条都正常出结果；`cat /home/work/.comate/baidu-cc/resources/settings.json | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8")); console.log("ok")'` 输出 `ok`（文件没被写坏）。

---

## 自检结果

按 writing-plans 的三项检查逐条对过，记录在此，便于执行时判断计划本身可不可信。

**1. 规格覆盖度**

本计划范围是拆分后的 **A1（后端可插拔基础设施）**，对应规格的以下章节：

| 规格章节 | 覆盖任务 |
|---|---|
| §8.1 `settings` 表 + `ai_chat_threads.backend` 列 | 任务 1、2 |
| §8.2 全局配置项与环境变量覆盖 | 任务 1、9、11 |
| §5.1 adapter 契约与 codex 原样搬迁 | 任务 3、4 |
| §5.1 registry | 任务 5 |
| §5.2 ducc adapter（`--session-id` / stream-json / init 带 skills） | 任务 6 |
| §5.2 ducc catalog（`ducc models`，不起 app-server） | 任务 7 |
| §5.3 读发生在每次 spawn、不缓存 | 任务 9 |
| §5.4 `backend` 留痕、不同则不 resume + 时间线说明 | 任务 10 |
| §5.5 模型列表整体更换、落回新后端默认 | 任务 12 |
| §5.6 `spawnGapMs` 错开 500ms | 任务 13 |
| §9.2「两套 adapter」 | 任务 4、6（各自的 `buildArgs`/`normalizeEvent` 断言） |
| §9.2「backend 不同不 resume」 | 任务 10 |
| §9.3 只能手验的 | 手工验证 1-4 |

规格中**不属于 A1** 的部分（§6 scheduler、§7 前端、§8.3 automation 接口、§8.4 删 codex 耦合、§9.2 剩余 5 条用例）留给 A2 与 B，不在本计划内。§10、§11、§12 是「不做」与风险记录，无需任务。

**2. 占位符扫描**

全文搜过 `TODO`、`待定`、`后续实现`、`类似任务`、`适当的错误处理` —— 无命中。每个涉及代码变更的步骤都带完整代码块，每个运行步骤都写了确切命令与预期输出。

**3. 类型一致性**

adapter 契约的 8 个字段 `{ id, resolveExecutable, needsCwd, spawnGapMs, buildArgs, buildPrompt, createNormalizer, discoverCatalog }` 在任务 4、5、6、7、9、13 中拼写一致。归一化事件的字段 `{ kind, type, role, content, data, outcome, threadId }` 在任务 4、6、9、10 中一致；`outcome` 只有 `"completed"|"failed"` 两个取值。`database.getSetting/setSetting` 在任务 1、9、11 中签名一致。`agentBackendIds()` / `DEFAULT_AGENT_BACKEND` / `resolveAgentBackend()` 三个导出在任务 5 定义、任务 9、11 使用，名字一致。

自检时抓到并已修掉一处：任务 4 原来只给 codex adapter 挂 `normalizeEvent`（一个函数），而任务 9 的运行时路径调的是 `backend.createNormalizer()`，会 `TypeError`。现在 codex adapter 同时挂两个 —— `createNormalizer: () => normalizeCodexEvent` 供运行时，`normalizeEvent` 供任务 5、9 的单测直接断言。

一处刻意的不一致值得记下来：函数名保留 `spawnCodexTurn`（任务 9 继续用这个名字），因为它管的是进程守护，与后端无关，改名会牵动 `server/ai-turn-owner.mjs` 一整套测试。规格 §5.1 明确说这层不动。

---

## 执行记录

13 个任务全部落地，13 个 commit（`3312a92` … `24192a2`）。

回归命令用的是**范围收窄版**，不是 `npm test`：

```bash
node --test $(ls test/*.test.mjs | grep -vE "cloud-|inject|task-editor")
```

`npm test` 在这台机器上有 24 个与本计划无关的既有红灯 —— cloud 那批要 D1/wrangler/miniflare，chromium 驱动的那批缺 dbus/UPower 直接 SIGSEGV。收窄后基线 308/308/0，做完 13 个任务是 **337/337/0**。`npx tsc --noEmit -p web/tsconfig.json` 干净。

实施中偏离计划的地方，共 5 处：

| # | 偏离 | 原因 |
|---|---|---|
| 1 | 全程用函数名/常量名 Grep 定位，不用计划里的行号 | 任务 1 落地后行号就开始漂，后面越漂越远 |
| 2 | 任务 6 测试的断言下标 `slice(4, 8)` → `slice(6, 10)` | `THREAD.id` 是合法 UUID，`--session-id <id>` 必然先占两项。计划笔误，已改回计划文档 |
| 3 | 任务 12 测试断言 `reasoningEffort` 从 `null` 改成 `"medium"` | ducc adapter 给每个模型的 `defaultReasoningEffort` 是 `"medium"`。计划笔误，已改回计划文档 |
| 4 | 任务 9 顺带改了 `test/ai-chat-runner.test.mjs` 里一处错误文案断言 | 步骤 7 把 `"Codex returned an unexpected thread id"` 改成了 `"The agent backend returned an unexpected session id"`，计划漏了提这条断言要跟着改 |
| 5 | 任务 12 新增 `#requireKnownModel()`，并删掉 runner 里 `model: "retired-model"` → `INVALID_MODEL` 那个场景 | `#resolveModel` 改成落回后，运行时不再报错；但 `createThread`/`updateThread` 收到用户显式传的未知 slug 仍应报 `INVALID_MODEL`，所以把校验从运行时路径挪到入参路径。计划步骤 6 已预见此分支 |

「手工验证」那一节还没做 —— 要真跑一轮 ducc，得在浏览器里操作。
