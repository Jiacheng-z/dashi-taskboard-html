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

// claude 不写死模型：剥掉 ducc args 里的 --model，让 CLI 用 cc-switch 控制的
// ~/.claude/settings.json 默认模型。静态 CLAUDE_MODELS 目录只喂给 #resolveModel
// 当合法 catalog（不能为空，否则 500 NO_MODELS），不代表真实可用渠道。
function buildClaudeArgs(thread, addDirectories, imagePaths) {
  const args = buildDuccArgs(thread, addDirectories, imagePaths);
  const modelIndex = args.indexOf("--model");
  if (modelIndex !== -1) args.splice(modelIndex, 2);
  return args;
}

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
  // 事件归一化 / prompt 与 ducc 逐字通用（同为 Claude Code 2.x 血统）；
  // buildArgs 例外：剥掉 --model，不写死模型名
  buildArgs: buildClaudeArgs,
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
