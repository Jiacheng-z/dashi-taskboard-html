# claude 后端适配器实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 给任务板本地 agent 增加一个 `claude` 后端（官方 Claude Code CLI），并设为默认 agent backend，ducc 被风控时可切过去。

**架构：** 复用 ducc 适配器的 flag 构建 / 事件归一化 / skill 扫描（同为 Claude Code 2.x 血统，逐字通用）；模型目录静态写死（`claude models` 输出非确定性，不能解析）；`resolveSchedulerConfig` 式的后端选择链（实例 > `TASKBOARD_AGENT_BACKEND` 环境变量 > DB 设置 > 默认）已存在，只把默认从 ducc 改成 claude。

**技术栈：** Node.js ESM、`node:test`、`node:assert/strict`

---

## 文件结构

- 修改：`server/agent-backends/ducc.mjs` — `executableOnPath(env)` 泛化为 `(env, name)` 并导出（claude 复用）。
- 创建：`server/agent-backends/claude.mjs` — `claudeBackend` 适配器。
- 修改：`server/agent-backends/index.mjs` — 注册 claude、`DEFAULT_AGENT_BACKEND` → `"claude"`。
- 创建：`test/agent-backend-claude.test.mjs` — claude 适配器 + 静态目录 + skill 扫描。
- 修改：`test/agent-backend-codex.test.mjs:6-13` — registry 默认断言。
- 修改：`test/ai-chat-server.test.mjs:414,421` — backend 接口 payload。

## 任务间依赖

- 任务 2 的 claude.mjs 要 import 任务 1 导出的 `executableOnPath`。
- 任务 3 的 index.mjs 要 import 任务 2 的 `claudeBackend`。

**commit 一律用 fork 身份**（仓库未配 user.name/user.email，不要改 global config）：
`git -c user.name='Jiacheng-z' -c user.email='jiacheng-z@users.noreply.github.com' commit`

---

### 任务 1：泛化并导出 ducc 的 executableOnPath

**文件：**
- 修改：`server/agent-backends/ducc.mjs:256-268`（`executableOnPath` 函数）
- 修改：`server/agent-backends/ducc.mjs:369-373`（`resolveExecutable`）

- [ ] **步骤 1：把函数参数化并导出**

把：

```js
function executableOnPath(env) {
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "ducc");
```

改为：

```js
export function executableOnPath(env, name) {
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
```

- [ ] **步骤 2：更新 ducc 的 resolveExecutable 调用点**

把：

```js
    return executableOnPath(env) ?? "ducc";
```

改为：

```js
    return executableOnPath(env, "ducc") ?? "ducc";
```

- [ ] **步骤 3：运行 ducc 既有测试确认重构无回归**

运行：`node --test test/agent-backend-ducc.test.mjs`
预期：全部 PASS（`test/agent-backend-ducc.test.mjs:53-71` 的 resolveExecutable 用例覆盖行为，重构破坏了会失败）。

- [ ] **步骤 4：Commit**

```bash
git add server/agent-backends/ducc.mjs
git -c user.name='Jiacheng-z' -c user.email='jiacheng-z@users.noreply.github.com' commit -m "refactor: executableOnPath 参数化可执行名并导出"
```

不要提交未跟踪的 `nohup.out` 或 `package.json.orig`。

---

### 任务 2：创建 claude 后端适配器（TDD）

**文件：**
- 创建：`test/agent-backend-claude.test.mjs`
- 创建：`server/agent-backends/claude.mjs`

- [ ] **步骤 1：编写失败的测试**

创建 `test/agent-backend-claude.test.mjs`：

```js
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { claudeBackend } from "../server/agent-backends/claude.mjs";
import { duccBackend } from "../server/agent-backends/ducc.mjs";

const THREAD = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  origin: { workspacePath: "/ws" },
  sandbox: "workspace-write",
  model: "claude-sonnet-5",
  reasoningEffort: "high",
  codexThreadId: null,
};

test("claude buildArgs reuses the ducc flags (same function)", () => {
  assert.equal(claudeBackend.buildArgs, duccBackend.buildArgs);
  assert.deepEqual(claudeBackend.buildArgs(THREAD, ["/other"], []), [
    "-p", "--output-format", "stream-json", "--verbose",
    "--session-id", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "--permission-mode", "acceptEdits",
    "--add-dir", "/other",
    "--model", "claude-sonnet-5",
    "--effort", "high",
  ]);
  assert.equal(claudeBackend.needsCwd, true);
  // 官方 claude 没有 bin/ducc 每次启动 sed -i 同一份 settings.json 的并发撞写问题
  assert.equal(claudeBackend.spawnGapMs, 0);
});

test("claude resolveExecutable prefers CLAUDE_EXECUTABLE, then PATH", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-claude-bin-"));
  try {
    const binDirectory = path.join(directory, "bin");
    await mkdir(binDirectory);
    const onPath = path.join(binDirectory, "claude");
    await writeFile(onPath, "#!/bin/sh\nexit 0\n");
    await chmod(onPath, 0o755);

    assert.equal(
      claudeBackend.resolveExecutable({ env: { CLAUDE_EXECUTABLE: " /explicit/claude " } }),
      "/explicit/claude",
    );
    assert.equal(claudeBackend.resolveExecutable({ env: { PATH: binDirectory } }), onPath);
    assert.equal(claudeBackend.resolveExecutable({ env: { PATH: "/nowhere-zzz" } }), "claude");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("claude normalizer is the ducc normalizer (same function)", () => {
  assert.equal(claudeBackend.createNormalizer, duccBackend.createNormalizer);
  const normalize = claudeBackend.createNormalizer();
  assert.deepEqual(normalize({
    type: "system",
    subtype: "init",
    session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  }), { kind: "thread.started", threadId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
});

async function writeSkill(root, name, description) {
  const directory = path.join(root, ".claude", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
  return path.join(directory, "SKILL.md");
}

test("claude discoverCatalog returns static models and scanned skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-claude-catalog-"));
  try {
    const workspacePath = path.join(root, "ws");
    const home = path.join(root, "home");
    await mkdir(workspacePath);
    const repoSkillPath = await writeSkill(workspacePath, "manage-taskboard", "看板任务操作");
    await writeSkill(home, "humanizer", "去掉 AI 味");

    const catalog = await claudeBackend.discoverCatalog({
      workspacePath,
      processEnv: { ...process.env, HOME: home },
    });

    assert.deepEqual(catalog.models.map((model) => model.slug), [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-haiku-4-5-20251001",
      "claude-fable-5",
    ]);
    assert.deepEqual(catalog.models[0], {
      slug: "claude-sonnet-5",
      displayName: "claude-sonnet-5",
      description: "",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
      serviceTiers: [],
    });
    assert.deepEqual(catalog.sandboxes, ["read-only", "workspace-write", "danger-full-access"]);
    assert.deepEqual(catalog.skills.map((skill) => skill.id), ["humanizer", "manage-taskboard"]);
    assert.equal(catalog.skills[1].path, repoSkillPath);
    assert.equal(catalog.skills[1].scope, "repo");
    assert.equal(catalog.skills[0].scope, "user");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claude discoverCatalog lets a repo skill win and tolerates missing directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-claude-catalog-"));
  try {
    const workspacePath = path.join(root, "ws");
    await mkdir(workspacePath);
    const repoSkillPath = await writeSkill(workspacePath, "humanizer", "仓库版");
    const home = path.join(root, "home");
    await writeSkill(home, "humanizer", "用户版");

    const catalog = await claudeBackend.discoverCatalog({
      workspacePath,
      processEnv: { ...process.env, HOME: home },
    });
    assert.equal(catalog.skills.length, 1);
    assert.equal(catalog.skills[0].path, repoSkillPath);
    assert.equal(catalog.skills[0].scope, "repo");

    const empty = await claudeBackend.discoverCatalog({
      workspacePath: root,
      processEnv: { ...process.env, HOME: path.join(root, "nowhere") },
    });
    assert.deepEqual(empty.skills, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/agent-backend-claude.test.mjs`
预期：FAIL，报错 `Cannot find module '../server/agent-backends/claude.mjs'`（claude.mjs 还不存在）。

- [ ] **步骤 3：编写 claude 后端适配器**

创建 `server/agent-backends/claude.mjs`：

```js
import { buildCodexPrompt } from "./codex.mjs";
import {
  buildDuccArgs,
  createDuccNormalizer,
  discoverDuccSkills,
  executableOnPath,
} from "./ducc.mjs";

// claude-sonnet-5 放第一位 = #resolveModel 的默认模型（取 catalog.models[0]）。
// `claude models` 输出非确定性（实测多次跑结果不同），不能解析，这里写死真实 slug。
const CLAUDE_MODELS = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
].map((slug) => ({
  slug,
  displayName: slug,
  description: "",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: ["low", "medium", "high", "max"],
  serviceTiers: [],
}));

const CLAUDE_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];

export const claudeBackend = {
  id: "claude",
  // 同 ducc：没有 codex 的 -C，工作区靠子进程 cwd
  needsCwd: true,
  // 官方 claude 没有 bin/ducc 每次启动 sed -i 同一份 settings.json 的并发撞写问题
  spawnGapMs: 0,
  resolveExecutable: ({ env = process.env } = {}) => {
    const explicit = env.CLAUDE_EXECUTABLE;
    if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
    return executableOnPath(env, "claude") ?? "claude";
  },
  // flag 构建 / 事件归一化 / prompt 与 ducc 逐字通用（同为 Claude Code 2.x 血统）
  buildArgs: buildDuccArgs,
  buildPrompt: buildCodexPrompt,
  createNormalizer: createDuccNormalizer,
  // 模型目录静态写死，不 spawn `claude models`（输出非确定性）
  discoverCatalog: async ({ workspacePath, processEnv }) => ({
    models: CLAUDE_MODELS,
    skills: await discoverDuccSkills({ workspacePath, processEnv }),
    sandboxes: [...CLAUDE_SANDBOXES],
  }),
  // 同 ducc：MCP 配置散在 ~/.claude.json 里，无公开稳定格式，先返回空数组
  discoverWorkflowCapabilities: async ({ workspacePath, processEnv }) => ({
    skills: await discoverDuccSkills({ workspacePath, processEnv }),
    mcpServers: [],
  }),
};
```

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/agent-backend-claude.test.mjs`
预期：全部 PASS（5 个测试）。

- [ ] **步骤 5：Commit**

```bash
git add server/agent-backends/claude.mjs test/agent-backend-claude.test.mjs
git -c user.name='Jiacheng-z' -c user.email='jiacheng-z@users.noreply.github.com' commit -m "feat: 新增 claude 后端适配器（复用 ducc 的 args/normalizer，静态模型目录）"
```

---

### 任务 3：注册 claude 并设为默认 agent backend

**文件：**
- 修改：`test/agent-backend-codex.test.mjs:6-13`
- 修改：`server/agent-backends/index.mjs`
- 修改：`test/ai-chat-server.test.mjs:414,421`

- [ ] **步骤 1：更新 registry 默认断言**

把 `test/agent-backend-codex.test.mjs:6-13`：

```js
test("registry defaults to ducc and falls back for unknown ids", () => {
  assert.equal(DEFAULT_AGENT_BACKEND, "ducc");
  assert.equal(resolveAgentBackend("ducc").id, "ducc");
  assert.equal(resolveAgentBackend("codex").id, "codex");
  assert.equal(resolveAgentBackend(null).id, "ducc");
  assert.equal(resolveAgentBackend(undefined).id, "ducc");
  assert.equal(resolveAgentBackend("gemini-whatever").id, "ducc");
});
```

改为：

```js
test("registry defaults to claude and falls back for unknown ids", () => {
  assert.equal(DEFAULT_AGENT_BACKEND, "claude");
  assert.equal(resolveAgentBackend("claude").id, "claude");
  assert.equal(resolveAgentBackend("ducc").id, "ducc");
  assert.equal(resolveAgentBackend("codex").id, "codex");
  assert.equal(resolveAgentBackend(null).id, "claude");
  assert.equal(resolveAgentBackend(undefined).id, "claude");
  assert.equal(resolveAgentBackend("gemini-whatever").id, "claude");
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/agent-backend-codex.test.mjs`
预期：FAIL——`DEFAULT_AGENT_BACKEND` 仍是 `"ducc"`，`resolveAgentBackend("claude")` 落回 ducc。

- [ ] **步骤 3：注册 claude 并改默认**

把 `server/agent-backends/index.mjs` 整个内容改为：

```js
import { claudeBackend } from "./claude.mjs";
import { codexBackend } from "./codex.mjs";
import { duccBackend } from "./ducc.mjs";

export const DEFAULT_AGENT_BACKEND = "claude";

const AGENT_BACKENDS = new Map([
  [claudeBackend.id, claudeBackend],
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

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/agent-backend-codex.test.mjs`
预期：PASS。

- [ ] **步骤 5：更新 backend 接口 payload 断言**

把 `test/ai-chat-server.test.mjs:414`：

```js
    assert.deepEqual(initial.body, { backend: "ducc", available: ["codex", "ducc"] });
```

改为：

```js
    assert.deepEqual(initial.body, { backend: "claude", available: ["claude", "codex", "ducc"] });
```

把 `test/ai-chat-server.test.mjs:421`：

```js
    assert.deepEqual(switched.body, { backend: "codex", available: ["codex", "ducc"] });
```

改为：

```js
    assert.deepEqual(switched.body, { backend: "codex", available: ["claude", "codex", "ducc"] });
```

- [ ] **步骤 6：运行定向测试确认通过**

运行：`node --test test/ai-chat-server.test.mjs --test-name-pattern="agent backend preference"`
预期：PASS（该用例其余断言——非法值 400、多余字段 400、错误方法 405——保持不变仍通过）。

- [ ] **步骤 7：Commit**

```bash
git add server/agent-backends/index.mjs test/agent-backend-codex.test.mjs test/ai-chat-server.test.mjs
git -c user.name='Jiacheng-z' -c user.email='jiacheng-z@users.noreply.github.com' commit -m "feat: 注册 claude 后端并设为默认 agent backend"
```

---

### 任务 4：运行项目收窄回归测试

**文件：** 无改动，纯验证。

- [ ] **步骤 1：运行收窄回归**

运行：

```bash
node --test $(ls test/*.test.mjs | grep -vE "cloud-|inject|task-editor")
```

预期：全部 PASS，无失败/取消。基线上次是 358/358/0，本次新增 claude 测试文件后总数会增加（新增 5 个用例）。

- [ ] **步骤 2：确认 git 状态干净**

运行：`git status --short`
预期：只剩未跟踪的 `nohup.out` 和 `package.json.orig`（不提交）。

---

## 自检记录

- **规格覆盖度：**
  - ducc.mjs 泛化导出 → 任务 1。✓
  - claude.mjs 适配器（静态模型、复用 args/normalizer/skills、`CLAUDE_EXECUTABLE`、spawnGapMs 0、needsCwd true）→ 任务 2。✓
  - index.mjs 注册 + `DEFAULT_AGENT_BACKEND` → claude → 任务 3。✓
  - 新增 claude 测试 + 修改 registry/endpoint 测试 → 任务 2/3。✓
  - 回归验证 → 任务 4。✓
  - 手工验证项（真跑 claude stream-json、启动后 GET backend）→ 不属于自动化测试，见规格「手工验证」，不进计划。✓
- **占位符扫描：** 每个步骤都含完整代码/命令/预期，无 "待定/TODO"。✓
- **类型一致性：** `executableOnPath(env, name)` 签名在任务 1/2 一致；`claudeBackend` 的 9 个契约字段与既有 adapter 一致；`agentBackendIds()` 顺序 `["claude", "codex", "ducc"]` 在任务 3 的 endpoint 断言里一致。✓
