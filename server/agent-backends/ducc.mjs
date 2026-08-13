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
