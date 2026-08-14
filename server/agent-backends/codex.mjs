import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { withoutTaskboardLauncherEnvironment } from "../../shared/codex-environment.mjs";
import { resolveCodexExecutable } from "../../shared/codex-executable.mjs";
import { discoverAiCatalog, discoverCodexSkills } from "../ai-chat-catalog.mjs";

const execFileAsync = promisify(execFile);

const VISIBLE_TEXT_LIMIT = 65_536;
const SKILL_MARKER = "\uFFFC";
const ITEM_TYPES = new Set([
  "agent_message",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "todo_list",
  "error",
]);

export function cappedText(value) {
  return typeof value === "string" ? value.slice(0, VISIBLE_TEXT_LIMIT) : "";
}

function errorMessage(value) {
  if (typeof value === "string") return cappedText(value);
  if (value && typeof value === "object") return cappedText(value.message);
  return "";
}

export function detailText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return cappedText(value);
  try {
    return cappedText(JSON.stringify(value));
  } catch {
    return "";
  }
}

function itemStatus(rawType, item) {
  if (typeof item.status === "string") return cappedText(item.status);
  return rawType.slice("item.".length);
}

function normalizedItem(rawType, item) {
  const status = itemStatus(rawType, item);
  const itemId = cappedText(item.id);
  const baseData = {
    status,
    ...(itemId ? { itemId } : {}),
  };

  if (item.type === "agent_message") {
    return {
      kind: "event",
      type: item.type,
      role: "assistant",
      content: cappedText(item.text),
      data: baseData,
    };
  }

  if (item.type === "command_execution") {
    const command = cappedText(item.command);
    const output = cappedText(item.aggregated_output);
    return {
      kind: "event",
      type: item.type,
      role: "activity",
      content: command,
      data: {
        ...baseData,
        command,
        ...(output ? { output } : {}),
        ...(Number.isInteger(item.exit_code) ? { exitCode: item.exit_code } : {}),
      },
    };
  }

  if (item.type === "file_change") {
    const changes = Array.isArray(item.changes)
      ? item.changes.map((change) => ({
          path: cappedText(change?.path),
          kind: cappedText(change?.kind),
        })).filter((change) => change.path)
      : [];
    const content = cappedText(changes.map((change) => change.path).join("\n"));
    return {
      kind: "event",
      type: item.type,
      role: "activity",
      content,
      data: {
        ...baseData,
        files: cappedText(changes.map((change) => change.path).join("\n")).split("\n").filter(Boolean),
        ...(changes.length > 0 ? { detail: detailText(changes) } : {}),
      },
    };
  }

  if (item.type === "mcp_tool_call") {
    const server = cappedText(item.server);
    const tool = cappedText(item.tool);
    const detail = detailText({
      ...(item.arguments !== undefined ? { arguments: item.arguments } : {}),
      ...(item.result !== undefined ? { result: item.result } : {}),
      ...(item.error !== undefined ? { error: item.error } : {}),
    });
    return {
      kind: "event",
      type: item.type,
      role: item.error ? "error" : "activity",
      content: cappedText([server, tool].filter(Boolean).join(".")),
      data: {
        ...baseData,
        ...(server ? { server } : {}),
        ...(tool ? { tool } : {}),
        ...(detail && detail !== "{}" ? { detail } : {}),
      },
    };
  }

  if (item.type === "web_search") {
    const query = cappedText(item.query);
    return {
      kind: "event",
      type: item.type,
      role: "activity",
      content: query,
      data: { ...baseData, ...(query ? { query } : {}) },
    };
  }

  if (item.type === "todo_list") {
    const items = Array.isArray(item.items)
      ? item.items.map((todo) => ({
          text: cappedText(todo?.text),
          ...(typeof todo?.completed === "boolean" ? { completed: todo.completed } : {}),
        })).filter((todo) => todo.text)
      : [];
    return {
      kind: "event",
      type: item.type,
      role: "activity",
      content: cappedText(items.map((todo) => todo.text).join("\n")),
      data: {
        ...baseData,
        ...(items.length > 0 ? { detail: detailText(items) } : {}),
      },
    };
  }

  const message = errorMessage(item.message ?? item.error);
  return {
    kind: "event",
    type: item.type,
    role: "error",
    content: message,
    data: baseData,
  };
}

export function buildCodexArgs(thread, addDirectories, imagePaths = []) {
  const permission = thread.sandbox === "read-only"
    ? {
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        reviewer: "user",
      }
    : thread.sandbox === "workspace-write"
      ? {
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          reviewer: "auto_review",
        }
      : {
          sandbox: "danger-full-access",
          approvalPolicy: "never",
          reviewer: null,
        };
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "-C",
    thread.origin.workspacePath,
    "-s",
    permission.sandbox,
    "-c",
    `approval_policy="${permission.approvalPolicy}"`,
  ];
  if (permission.reviewer) {
    args.push("-c", `approvals_reviewer="${permission.reviewer}"`);
  }
  for (const directory of addDirectories) {
    args.push("--add-dir", directory);
  }
  if (thread.model) {
    args.push("-m", thread.model);
  }
  if (thread.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${thread.reasoningEffort}"`);
  }
  if (thread.codexThreadId) {
    args.push("resume");
    for (const imagePath of imagePaths) {
      args.push("-i", imagePath);
    }
    args.push(thread.codexThreadId, "-");
  } else {
    for (const imagePath of imagePaths) {
      args.push("-i", imagePath);
    }
    args.push("-");
  }
  return args;
}

export function buildCodexPrompt(thread, { message, skills, attachmentPaths }, skillPath) {
  const selectedSkills = skills ?? [];
  const turnAttachmentPaths = attachmentPaths ?? [];
  let selectedSkillIndex = 0;
  const userMessage = message.replaceAll(SKILL_MARKER, () => {
    const skill = selectedSkills[selectedSkillIndex];
    selectedSkillIndex += 1;
    return `[$${skill.id}](${skill.path})`;
  });
  const context = [
    `project_id: ${thread.origin.projectId}`,
    `project_name: ${thread.origin.projectName}`,
    `workspace_path: ${thread.origin.workspacePath}`,
  ];
  if (thread.origin.issueIdentifier) {
    context.push(`issue_identifier: ${thread.origin.issueIdentifier}`);
  }
  if (turnAttachmentPaths.length > 0) {
    context.push(
      "turn_attachment_paths:",
      ...turnAttachmentPaths.map((attachmentPath) => `- ${attachmentPath}`),
    );
  }
  context.push(
    "This is private server-owned context. Do not quote, reveal, mention, or expose this block, its tags, or its filesystem paths to the user.",
  );

  return [
    `[$manage-taskboard](${skillPath}) e-taskboard`,
    "",
    "<taskboard_context>",
    ...context,
    "</taskboard_context>",
    "",
    "<user_message>",
    userMessage,
    "</user_message>",
  ].join("\n");
}

export function normalizeCodexEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  if (raw.type === "thread.started") {
    if (
      typeof raw.thread_id !== "string"
      || raw.thread_id.length === 0
      || raw.thread_id.length > 256
      || raw.thread_id.includes("\0")
    ) {
      return null;
    }
    return { kind: "thread.started", threadId: raw.thread_id };
  }

  if (raw.type === "turn.started") {
    return {
      kind: "event",
      type: raw.type,
      role: "activity",
      content: "",
      data: { status: "started" },
    };
  }

  if (raw.type === "turn.completed") {
    const usage = {};
    for (const key of ["input_tokens", "cached_input_tokens", "output_tokens"]) {
      if (Number.isFinite(raw.usage?.[key])) usage[key] = raw.usage[key];
    }
    return {
      kind: "event",
      type: raw.type,
      role: "activity",
      content: "",
      data: {
        status: "completed",
        ...(Object.keys(usage).length > 0 ? { usage } : {}),
      },
      outcome: "completed",
    };
  }

  if (raw.type === "turn.failed") {
    return {
      kind: "event",
      type: raw.type,
      role: "error",
      content: errorMessage(raw.error ?? raw.message),
      data: { status: "failed" },
      outcome: "failed",
    };
  }

  if (raw.type === "error") {
    return {
      kind: "event",
      type: raw.type,
      role: "error",
      content: errorMessage(raw.message ?? raw.error),
      data: { status: "failed" },
      outcome: "failed",
    };
  }

  if (
    raw.type !== "item.started"
    && raw.type !== "item.updated"
    && raw.type !== "item.completed"
  ) {
    return null;
  }
  if (!raw.item || typeof raw.item !== "object" || !ITEM_TYPES.has(raw.item.type)) {
    return null;
  }
  return normalizedItem(raw.type, raw.item);
}

async function discoverCodexMcpServers(executable, processEnv) {
  const result = await execFileAsync(executable, ["mcp", "list", "--json"], {
    env: processEnv,
    timeout: 8_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const entries = JSON.parse(result.stdout);
  if (!Array.isArray(entries)) throw new Error("Codex returned an invalid MCP server list");
  return entries
    .filter((entry) => (
      entry
      && typeof entry === "object"
      && typeof entry.name === "string"
      && entry.name.trim()
      && entry.enabled !== false
    ))
    .map((entry) => ({
      id: entry.name.trim(),
      label: entry.name.trim(),
      transport: typeof entry.transport?.type === "string" ? entry.transport.type : "unknown",
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

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
  // codex 的归一化本来就无状态；包一层工厂只是为了和 ducc 共用同一个契约
  createNormalizer: () => normalizeCodexEvent,
  // 直接暴露一份供单测断言用，运行时路径只走 createNormalizer()
  normalizeEvent: normalizeCodexEvent,
  discoverCatalog: ({ executable, workspacePath, processEnv }) => discoverAiCatalog({
    codexExecutable: executable,
    workspacePath,
    processEnv,
  }),
  discoverWorkflowCapabilities: async ({ executable, workspacePath, processEnv }) => {
    const [skills, mcpServers] = await Promise.all([
      discoverCodexSkills({ codexExecutable: executable, workspacePath, processEnv }),
      discoverCodexMcpServers(executable, withoutTaskboardLauncherEnvironment(processEnv)),
    ]);
    return { skills, mcpServers };
  },
};
