# claude 后端适配器设计

> 状态：待用户审查。目标：给任务板本地 agent 增加一个 `claude` 后端，用官方 Claude Code CLI（`claude`）跑 agent 会话，ducc 被风控时能切过去。

## 背景与动机

- ducc（百度重打包版 Claude Code）当前是任务板的默认 agent 后端，可能被风控。
- 本机有官方 Claude Code CLI：`/usr/local/bin/claude`（2.1.223），与 ducc 同属 Claude Code 2.x 血统：
  - 支持 ducc 适配器传的所有 flag（`-p`、`--output-format stream-json`、`--verbose`、`--session-id`、`--resume`、`--permission-mode`、`--disallowedTools`、`--add-dir`、`--model`、`--effort`）。
  - stream-json 事件格式与 ducc 一致（`system/init` → thread.started，assistant/user 块，`result` → turn.completed/failed），`createDuccNormalizer` 可直接复用。
- **关键事实：`claude models` 输出非确定性**（实测 5 次输出各不相同：markdown 表格 / 带/不带加粗的列表、模型数量、尾部说明文字都不同），不能当机器接口解析。claude 目录必须用写死的静态列表。

## 决策

1. **模型目录静态写死**，不跑 `claude models`。
   - 默认模型 = `models[0]` = `claude-sonnet-5`（`#resolveModel` 取 catalog.models[0] 当默认）。
   - 列表：`["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001", "claude-fable-5"]`（均来自实测 `claude models` 输出里的真实 slug）。
2. **默认后端改为 `claude`**；切回 ducc/codex 用已有机制：启动时 `TASKBOARD_AGENT_BACKEND=ducc` 环境变量，或 `PATCH /api/local/ai/backend`（运行时）。两者都已存在且不用改。
3. **不新增 UI**。后端选择现状就是纯 HTTP / 环境变量（前端无 backend 控件），claude 也照此办理。与并发配置一致：启动时设变量即可。
4. **复用 ducc 适配器的产物**：`buildDuccArgs`（flag 构建）、`createDuccNormalizer`（事件归一化）、`discoverDuccSkills`（skill 扫描）。claude 与 ducc 是同血统 CLI，这些逐字通用。
5. `spawnGapMs: 0`——官方 `claude` 没有 `bin/ducc:26-27` 那种每次启动 `sed -i` 同一份 settings.json 的问题，并发启动不需要错开。

## 文件结构

- 新增：`server/agent-backends/claude.mjs`
- 修改：`server/agent-backends/index.mjs`（注册 claude、`DEFAULT_AGENT_BACKEND` → `"claude"`）
- 修改：`server/agent-backends/ducc.mjs`（把内部 `executableOnPath` 参数化 `(env, name)` 并 export）
- 新增：`test/agent-backend-claude.test.mjs`（adapter + 静态目录 + skill 扫描）
- 修改：`test/agent-backend-codex.test.mjs`（registry 默认断言）
- 修改：`test/ai-chat-server.test.mjs`（backend 接口 payload）

## 实现细节

### `server/agent-backends/ducc.mjs`（唯一必要改动）

```js
// 现在的内部实现（第 256-268 行）只写死 "ducc"，claude 也要同款查找
function executableOnPath(env) { /* path.join(directory, "ducc") */ }

// 改为：参数化名字并导出
export function executableOnPath(env, name) {
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 继续找下一个 PATH 条目
    }
  }
  return null;
}
```

`duccBackend.resolveExecutable` 相应改成 `return executableOnPath(env, "ducc") ?? "ducc";`。除此之外 ducc.mjs 不动。

### `server/agent-backends/claude.mjs`（新增）

```js
import { buildCodexPrompt } from "./codex.mjs";
import {
  buildDuccArgs,
  createDuccNormalizer,
  discoverDuccSkills,
  executableOnPath,
} from "./ducc.mjs";

// 静态模型目录。claude-sonnet-5 放第一位 = 默认模型。
const CLAUDE_MODELS = [
  ["claude-sonnet-5"],
  ["claude-opus-5"],
  ["claude-haiku-4-5-20251001"],
  ["claude-fable-5"],
].map(([slug]) => ({
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
  // 官方 claude 没有 bin/ducc 的 sed -i settings.json 启动冲突，不需要错开
  spawnGapMs: 0,
  resolveExecutable: ({ env = process.env } = {}) => {
    const explicit = env.CLAUDE_EXECUTABLE;
    if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
    return executableOnPath(env, "claude") ?? "claude";
  },
  // flag 构建 / 事件归一化 / prompt 与 ducc 逐字通用
  buildArgs: buildDuccArgs,
  buildPrompt: buildCodexPrompt,
  createNormalizer: createDuccNormalizer,
  discoverCatalog: async ({ workspacePath, processEnv }) => ({
    models: CLAUDE_MODELS,
    skills: await discoverDuccSkills({ workspacePath, processEnv }),
    sandboxes: [...CLAUDE_SANDBOXES],
  }),
  // 同 ducc：MCP 配置散在 ~/.claude.json 里，无公开稳定格式，返回空数组
  discoverWorkflowCapabilities: async ({ workspacePath, processEnv }) => ({
    skills: await discoverDuccSkills({ workspacePath, processEnv }),
    mcpServers: [],
  }),
};
```

说明：
- `CLAUDE_EXECUTABLE` 环境变量可显式指定可执行文件路径（与 `DUCC_EXECUTABLE` 对称）。
- claude 需要 `needsCwd: true`（没有 codex 的 `-C`）。
- 模型目录里不跑子进程，`discoverCatalog` 不需要 `executable` 参数。

### `server/agent-backends/index.mjs`

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
```

- claude 放 Map 第一位 → `agentBackendIds()` 返回 `["claude", "codex", "ducc"]`。
- `resolveAgentBackend` 的「未知 id 落回默认」逻辑不变，只是默认从 ducc 变 claude。

### 运行路径（均已有，无需改）

- 后端选择：`agentBackendId`（实例）> `TASKBOARD_AGENT_BACKEND` 环境变量 > DB 设置 `agent_backend` > `DEFAULT_AGENT_BACKEND`（ai-chat.mjs:121-128）。环境变量在启动时设即可生效，无需改代码。
- 可执行文件解析：`#executableFor`（ai-chat.mjs:130-135）对非 codex 后端调 `backend.resolveExecutable({ env: this.processEnv })`。
- 默认模型：`#resolveModel` 取 `catalog.models[0]` = claude-sonnet-5。

## 测试

### 新增 `test/agent-backend-claude.test.mjs`

1. **resolveExecutable**
   - `CLAUDE_EXECUTABLE` 环境变量显式指定 → 返回该路径。
   - 不设变量、PATH 里有可执行 `claude` → 返回找到的路径。
   - 不设变量、PATH 无 → 返回 `"claude"` 字面量。
   - （参考 `test/agent-backend-ducc.test.mjs` 的 fixture 写法，用 tmpdir 造可执行文件。）
2. **复用关系**（引用相等）
   - `claudeBackend.buildArgs === duccBackend.buildArgs`。
   - `claudeBackend.createNormalizer === duccBackend.createNormalizer`。
   - `claudeBackend.needsCwd === true`、`claudeBackend.spawnGapMs === 0`。
3. **静态目录 + skill 扫描**
   - `discoverCatalog` 返回 4 个模型，`models[0].slug === "claude-sonnet-5"`，`supportedReasoningEfforts`/`defaultReasoningEffort` 符合预期，`sandboxes` 是三个合法值。
   - 复用 `test/agent-backend-ducc-catalog.test.mjs` 的 `writeSkill` 模式：
     - repo skill 覆盖 user 同名 skill；
     - 两个 `.claude/skills` 都不存在时返回空数组不抛。
   - `discoverCatalog` 不需要可执行文件（静态目录，不 spawn）。

### 修改既有测试

4. **`test/agent-backend-codex.test.mjs:6-13`**（registry 默认断言）
   - `DEFAULT_AGENT_BACKEND === "claude"`。
   - `resolveAgentBackend("claude").id === "claude"`（新增断言）。
   - `resolveAgentBackend(null / undefined / "gemini-whatever").id === "claude"`。
   - `resolveAgentBackend("ducc").id === "ducc"`、`resolveAgentBackend("codex").id === "codex"` 不变。
   - 测试标题改为「registry defaults to claude and falls back for unknown ids」。
5. **`test/ai-chat-server.test.mjs:414,421`**（backend 接口 payload）
   - GET 默认：`{ backend: "claude", available: ["claude", "codex", "ducc"] }`。
   - PATCH 到 codex 后：`{ backend: "codex", available: ["claude", "codex", "ducc"] }`。
   - 其余断言（非法值 400、多余字段 400、错误方法 405）不变。

### 不会破坏的既有测试（已核实）

- `test/agent-backend-switch.test.mjs`：每个用例都显式 `setSetting("agent_backend", ...)` 或设环境变量，不依赖默认值。
- `test/agent-backend-ducc.test.mjs` / `test/agent-backend-ducc-catalog.test.mjs`：只测 ducc 自身行为，与默认无关。
- `test/ai-chat-database.test.mjs:208-238`：显式 `backend: "ducc"` 建线程，不走默认。

## 回归验证

```bash
node --test $(ls test/*.test.mjs | grep -vE "cloud-|inject|task-editor")
```

预期全 PASS，无失败/取消。基线上次 A2 收尾是 358/358/0，本次新增 claude 测试文件后总数会增。

## 手工验证（非自动测试）

- 真跑 `claude -p --output-format stream-json --verbose --session-id <uuid>` 确认 stream-json 事件能归一化成 thread.started / agent_message / turn.completed。
- 启动 taskboard 后 `GET /api/local/ai/backend` 应返回 `{ backend: "claude", available: ["claude", "codex", "ducc"] }`。

## 不做的事

- 不解析 `claude models` 输出（非确定性）。
- 不新增前端 UI / 不在线切换后端（用户明确：启动时设变量就行）。
- 不改并发配置（已确认走 `TASKBOARD_CONCURRENCY` 环境变量，零代码改动）。
- 不碰 ducc 的 catalog 解析 / 事件归一化逻辑（claude 只是复用）。
