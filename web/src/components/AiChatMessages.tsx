import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTaskboardI18n } from "../i18n";
import { AI_CHAT_SKILL_MARKER, aiChatEventStatus, filterVisibleAiEvents } from "../aiChatState";
import type { AiChatEvent, AiChatSkill } from "../types";
import { LinearIcon, type LinearIconName } from "./LinearIcon";

const SKILL_MARKER = AI_CHAT_SKILL_MARKER;
const SKILL_LINK_PREFIX = "#ai-chat-skill-";

const SKILL_ACRONYMS = new Map([
  ["ai", "AI"],
  ["api", "API"],
  ["cli", "CLI"],
  ["mcp", "MCP"],
  ["sdk", "SDK"],
  ["ui", "UI"],
]);

export function skillDisplayName(skill: Pick<AiChatSkill, "id" | "label">): string {
  const rawLabel = skill.label === skill.id && skill.id.includes(":")
    ? skill.id.slice(skill.id.lastIndexOf(":") + 1)
    : skill.label;
  return rawLabel
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => (
      SKILL_ACRONYMS.get(word.toLocaleLowerCase())
      ?? (/^[A-Z][A-Za-z0-9]*$/.test(word)
        ? word
        : `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`)
    ))
    .join(" ");
}

export function eventSkillIds(event: AiChatEvent): string[] {
  const values = event.data?.skillIds;
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === "string");
}

function skillMarkdown(
  content: string,
  skillIds: string[],
  skillsById: Map<string, AiChatSkill>,
): string {
  let index = 0;
  return content.replaceAll(SKILL_MARKER, () => {
    const skillId = skillIds[index] ?? "";
    index += 1;
    const skill = skillsById.get(skillId);
    const label = skill
      ? skillDisplayName(skill)
      : skillDisplayName({ id: skillId, label: skillId });
    return `[${label.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${SKILL_LINK_PREFIX}${encodeURIComponent(skillId)})`;
  });
}

export function SkillReference({
  skill,
  skillId,
}: {
  skill?: AiChatSkill;
  skillId: string;
}) {
  return (
    <span
      className="ai-chat-skill-reference"
      data-skill-id={skillId || undefined}
    >
      <LinearIcon name="project" />
      <span>{skill ? skillDisplayName(skill) : skillDisplayName({ id: skillId, label: skillId })}</span>
    </span>
  );
}

const ACTIVITY_LABELS: Record<string, readonly [string, string]> = {
  plan: ["执行计划", "Plan"],
  todo: ["任务进度", "Task progress"],
  todo_list: ["任务进度", "Task progress"],
  command: ["运行命令", "Run command"],
  command_execution: ["运行命令", "Run command"],
  file: ["文件修改", "File changes"],
  file_change: ["文件修改", "File changes"],
  mcp: ["调用 MCP", "Use MCP"],
  mcp_tool_call: ["调用 MCP", "Use MCP"],
  skill: ["调用 Skill", "Use Skill"],
  web: ["搜索资料", "Search the web"],
  web_search: ["搜索资料", "Search the web"],
  error: ["执行失败", "Failed"],
  "turn.failed": ["执行失败", "Failed"],
};

const ACTIVITY_ICONS: Record<string, LinearIconName> = {
  plan: "write",
  todo: "status",
  todo_list: "status",
  command: "terminal",
  command_execution: "terminal",
  file: "file",
  file_change: "file",
  mcp: "link",
  mcp_tool_call: "link",
  skill: "project",
  web: "search",
  web_search: "search",
  error: "alert",
  "turn.failed": "alert",
};

type ThinkingActivityDetail =
  | { kind: "lines"; summary: string; value: string[] }
  | { kind: "pre"; summary: string; value: string };

function parsedTodoLines(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const items = JSON.parse(value);
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const text = (item as Record<string, unknown>).text;
      return typeof text === "string" && text.trim() ? [text] : [];
    });
  } catch {
    return [];
  }
}

function activityDetail(
  event: AiChatEvent,
  text: (chinese: string, english: string) => string,
): ThinkingActivityDetail | null {
  const files = event.data?.files;
  if (Array.isArray(files)) {
    const visibleFiles = files.filter((value): value is string => typeof value === "string");
    if (visibleFiles.length > 0) {
      return { kind: "lines", summary: text("查看文件", "View files"), value: visibleFiles };
    }
  }
  if (event.type === "todo" || event.type === "todo_list") {
    const lines = parsedTodoLines(event.data?.detail);
    if (lines.length > 0) {
      return { kind: "lines", summary: text("查看任务", "View tasks"), value: lines };
    }
  }
  for (const key of ["output", "command", "detail", "path"]) {
    const value = event.data?.[key];
    if (typeof value === "string" && value.trim()) {
      return {
        kind: "pre",
        summary: activityDetailSummary(event, text),
        value,
      };
    }
  }
  return null;
}

function activityDetailSummary(
  event: AiChatEvent,
  text: (chinese: string, english: string) => string,
): string {
  if (typeof event.data?.output === "string" && event.data.output.trim()) return text("查看输出", "View output");
  if (typeof event.data?.command === "string" && event.data.command.trim()) return text("查看命令", "View command");
  if (typeof event.data?.detail === "string" && event.data.detail.trim()) return text("查看详情", "View details");
  if (typeof event.data?.path === "string" && event.data.path.trim()) return text("查看路径", "View path");
  if (Array.isArray(event.data?.files)) return text("查看文件", "View files");
  return text("查看详情", "View details");
}

export function MarkdownMessage({
  children,
  skillsById,
}: {
  children: string;
  skillsById?: Map<string, AiChatSkill>;
}) {
  return (
    <div className="ai-chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, href, ...props }) => {
            if (href?.startsWith(SKILL_LINK_PREFIX)) {
              const skillId = decodeURIComponent(href.slice(SKILL_LINK_PREFIX.length));
              return <SkillReference skill={skillsById?.get(skillId)} skillId={skillId} />;
            }
            return <a {...props} href={href} target="_blank" rel="noreferrer" />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function ThinkingStepDetail({
  detail,
}: {
  detail: ThinkingActivityDetail;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className={`ai-chat-thinking-detail${isOpen ? " is-open" : ""}`}>
      <button
        aria-expanded={isOpen}
        className="ai-chat-thinking-detail-trigger"
        onClick={() => setIsOpen((open) => !open)}
        type="button"
      >
        <span>{detail.summary}</span>
        <LinearIcon name="chevronRight" />
      </button>
      <div
        aria-hidden={!isOpen}
        className="ai-chat-thinking-detail-panel"
        inert={!isOpen}
      >
        <div className="ai-chat-thinking-detail-panel-inner">
          {detail.kind === "lines" ? (
            <div className="ai-chat-thinking-detail-lines">
              {detail.value.map((line, index) => (
                <span key={`${line}-${index}`}>{line}</span>
              ))}
            </div>
          ) : (
            <pre><code>{detail.value}</code></pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function ThinkingSteps({
  events,
  active,
}: {
  events: AiChatEvent[];
  active: boolean;
}) {
  const { text } = useTaskboardI18n();
  const statuses = events.map(aiChatEventStatus);
  const status = statuses.includes("running")
    ? "running"
    : statuses.includes("failed") ? "failed" : "completed";
  const [isOpen, setIsOpen] = useState(active);
  const previousActiveRef = useRef(active);

  useEffect(() => {
    if (previousActiveRef.current === active) return;
    previousActiveRef.current = active;
    setIsOpen(active);
  }, [active]);

  const statusLabel = status === "running"
    ? text("思考中", "Thinking")
    : status === "failed"
      ? text("思考中断", "Thinking stopped")
      : text("已思考", "Thought");

  return (
    <section className={`ai-chat-thinking-steps is-${status}`}>
      <button
        aria-expanded={isOpen}
        className="ai-chat-thinking-header"
        onClick={() => setIsOpen((open) => !open)}
        type="button"
      >
        <span className="ai-chat-thinking-label">{statusLabel}</span>
        <LinearIcon className="ai-chat-thinking-chevron" name="chevronRight" />
      </button>
      <div
        aria-hidden={!isOpen}
        className={`ai-chat-thinking-panel${isOpen ? " is-open" : ""}`}
        inert={!isOpen}
      >
        <div className="ai-chat-thinking-panel-clip">
          <div className="ai-chat-thinking-list">
            {events.map((event, index) => {
              const eventStatus = aiChatEventStatus(event);
              const detail = activityDetail(event, text);
              const activityLabel = ACTIVITY_LABELS[event.type];
              const content = detail?.kind === "lines"
                && (event.type === "file" || event.type === "file_change")
                ? text(
                  `${detail.value.length} 个文件`,
                  `${detail.value.length} ${detail.value.length === 1 ? "file" : "files"}`,
                )
                : detail?.kind === "lines"
                  && (event.type === "todo" || event.type === "todo_list")
                  ? text(
                    `${detail.value.length} 项任务`,
                    `${detail.value.length} ${detail.value.length === 1 ? "task" : "tasks"}`,
                  )
                  : event.content.trim();
              return (
                <div
                  className="ai-chat-thinking-step-entry"
                  key={typeof event.data?.itemId === "string" && event.data.itemId
                    ? event.data.itemId
                    : event.id}
                  style={{ animationDelay: `${Math.min(index * 40, 240)}ms` }}
                >
                  <div className={`ai-chat-thinking-step is-${eventStatus}${index === events.length - 1 ? " is-last" : ""}`}>
                    <span className="ai-chat-thinking-step-rail" aria-hidden="true">
                      <span className="ai-chat-thinking-step-icon">
                        <LinearIcon name={eventStatus === "failed" ? "alert" : ACTIVITY_ICONS[event.type] ?? "statusTodo"} />
                      </span>
                      {index !== events.length - 1 && (
                        <span className="ai-chat-thinking-step-connector" />
                      )}
                    </span>
                    <div className="ai-chat-thinking-step-content">
                      <div className="ai-chat-thinking-step-heading">
                        <span className="ai-chat-thinking-step-label">
                          {activityLabel
                            ? text(...activityLabel)
                            : text("执行活动", "Activity")}
                          {eventStatus === "running" && <span aria-hidden="true">…</span>}
                        </span>
                        {content && (
                          <span className="ai-chat-thinking-step-description">
                            {content}
                          </span>
                        )}
                      </div>
                      {detail && (
                        <ThinkingStepDetail detail={detail} />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

export function EventAttachments({ event }: { event: AiChatEvent }) {
  const rawAttachments = event.data?.attachments;
  if (!Array.isArray(rawAttachments)) return null;
  const attachments = rawAttachments.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const attachment = value as Record<string, unknown>;
    if (
      typeof attachment.filename !== "string"
      || typeof attachment.contentType !== "string"
      || typeof attachment.size !== "number"
    ) return [];
    return [{
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
    }];
  });
  if (attachments.length === 0) return null;
  return (
    <div className="ai-chat-event-attachments">
      {attachments.map((attachment, index) => (
        <span key={`${attachment.filename}-${index}`}>
          <LinearIcon name="attachment" />
          <span>{attachment.filename}</span>
        </span>
      ))}
    </div>
  );
}

export function MessageTimeline({
  activeRunId,
  events,
  skills,
  onCopy,
}: {
  activeRunId: string | null;
  events: AiChatEvent[];
  skills: AiChatSkill[];
  onCopy: (event: ReactClipboardEvent<HTMLElement>, skillsById: Map<string, AiChatSkill>) => void;
}) {
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const timeline = filterVisibleAiEvents(events).reduce<Array<AiChatEvent | AiChatEvent[]>>(
    (items, event) => {
      const isMessage = event.role === "user"
        || event.type === "user"
        || event.type === "user_message"
        || event.role === "assistant"
        || event.type === "assistant"
        || event.type === "agent_message";
      if (isMessage) {
        items.push(event);
        return items;
      }
      const previous = items[items.length - 1];
      if (Array.isArray(previous)) previous.push(event);
      else items.push([event]);
      return items;
    },
    [],
  );
  return (
    <>
      {timeline.map((entry) => {
        if (Array.isArray(entry)) {
          return (
            <ThinkingSteps
              active={Boolean(
                activeRunId
                && entry.some((event) => event.runId === activeRunId),
              )}
              events={entry}
              key={`activity-${
                typeof entry[0]?.data?.itemId === "string" && entry[0].data.itemId
                  ? entry[0].data.itemId
                  : entry[0]?.id ?? "empty"
              }`}
            />
          );
        }
        const event = entry;
        if (event.role === "user" || event.type === "user" || event.type === "user_message") {
          return (
            <article
              className="ai-chat-user-message"
              key={event.id}
              onCopy={(copyEvent) => onCopy(copyEvent, skillsById)}
            >
              <MarkdownMessage skillsById={skillsById}>
                {skillMarkdown(event.content, eventSkillIds(event), skillsById)}
              </MarkdownMessage>
              <EventAttachments event={event} />
            </article>
          );
        }
        if (event.role === "assistant" || event.type === "assistant" || event.type === "agent_message") {
          return (
            <article className="ai-chat-assistant-message" key={event.id}>
              <MarkdownMessage>{event.content}</MarkdownMessage>
            </article>
          );
        }
        return null;
      })}
    </>
  );
}

export function OptionMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="ai-chat-option-menu" role="menu" aria-label={label}>
      {children}
    </div>
  );
}

