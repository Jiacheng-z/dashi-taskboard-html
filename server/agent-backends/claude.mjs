import { buildCodexPrompt } from "./codex.mjs";
import {
  buildDuccArgs,
  createDuccNormalizer,
  discoverDuccModels,
  discoverDuccSkills,
  executableOnPath,
} from "./ducc.mjs";

const CLAUDE_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];

// claude 和 ducc 同一个 base-url（oneapi），模型目录完全一致，直接复用
// `ducc models` 的解析结果，不用在这里手写第二份、和 ducc 侧脱节的名字列表。
function resolveDuccExecutable(env) {
  const explicit = env.DUCC_EXECUTABLE;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  return executableOnPath(env, "ducc") ?? "ducc";
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
  // flag 构建 / 事件归一化 / prompt 与 ducc 逐字通用（同为 Claude Code 2.x 血统）。
  // --model 直接传界面选的 catalog slug（如 "Claude Sonnet 5"），因为
  // discoverCatalog 就是从 `ducc models` 里读出来的同一份名字。
  buildArgs: buildDuccArgs,
  buildPrompt: buildCodexPrompt,
  createNormalizer: createDuccNormalizer,
  // 与 ducc 同一个 base-url（oneapi），模型目录直接 spawn `ducc models` 复用，
  // 不在这里手写第二份、容易和 ducc 侧脱节的静态列表。
  discoverCatalog: async ({ workspacePath, processEnv }) => {
    const environment = processEnv ?? process.env;
    const [models, skills] = await Promise.all([
      discoverDuccModels({
        executable: resolveDuccExecutable(environment),
        workspacePath,
        processEnv: environment,
      }),
      discoverDuccSkills({ workspacePath, processEnv: environment }),
    ]);
    return { models, skills, sandboxes: [...CLAUDE_SANDBOXES] };
  },
  // 同 ducc：MCP 配置散在 ~/.claude.json 里，无公开稳定格式，先返回空数组
  discoverWorkflowCapabilities: async ({ workspacePath, processEnv }) => ({
    skills: await discoverDuccSkills({ workspacePath, processEnv }),
    mcpServers: [],
  }),
};
