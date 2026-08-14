import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { withoutTaskboardLauncherEnvironment } from "../../shared/codex-environment.mjs";
import { buildCodexPrompt, cappedText, detailText } from "./codex.mjs";

const execFileAsync = promisify(execFile);

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

export async function discoverDuccSkills({ workspacePath, processEnv = process.env }) {
  const environment = withoutTaskboardLauncherEnvironment(processEnv);
  const homeDirectory = environment.HOME || os.homedir();
  const [userSkills, repoSkills] = await Promise.all([
    skillsInDirectory(path.join(homeDirectory, ".claude", "skills"), "user"),
    skillsInDirectory(path.join(workspacePath, ".claude", "skills"), "repo"),
  ]);
  // 同名时仓库级覆盖用户级（与 ducc 自己的加载优先级一致）
  const unique = new Map();
  for (const skill of [...userSkills, ...repoSkills]) unique.set(skill.id, skill);
  return [...unique.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export async function discoverDuccCatalog({ executable, workspacePath, processEnv = process.env }) {
  const environment = withoutTaskboardLauncherEnvironment(processEnv);
  const [models, skills] = await Promise.all([
    execFileAsync(executable, ["models"], {
      cwd: workspacePath,
      env: environment,
      encoding: "utf8",
      timeout: CATALOG_TIMEOUT_MS,
      maxBuffer: CATALOG_MAX_BUFFER,
    }).then((result) => parseDuccModels(result.stdout)).catch(() => []),
    discoverDuccSkills({ workspacePath, processEnv }),
  ]);
  return { models, skills, sandboxes: [...DUCC_SANDBOXES] };
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
  discoverCatalog: discoverDuccCatalog,
  // ducc 没有 `mcp list` 这类命令，MCP 配置散在 ~/.claude.json 里且没有公开的稳定格式，
  // 先返回空数组 —— 工作流面板的 MCP 选项对 ducc 就是空的（已记在「已知限制」）
  discoverWorkflowCapabilities: async ({ workspacePath, processEnv }) => ({
    skills: await discoverDuccSkills({ workspacePath, processEnv }),
    mcpServers: [],
  }),
};
