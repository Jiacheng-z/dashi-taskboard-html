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
