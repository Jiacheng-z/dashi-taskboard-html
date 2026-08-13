import { accessSync, constants } from "node:fs";
import path from "node:path";

import { buildCodexPrompt, cappedText, detailText } from "./codex.mjs";

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
  createNormalizer: createDuccNormalizer,
};
