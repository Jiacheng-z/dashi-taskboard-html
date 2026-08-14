import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTaskboardI18n } from "../i18n";
import {
  createAiChatThread,
  getAiChatCatalog,
  getAiChatThread,
  interruptAiChatRun,
  startAiChatTurn,
  subscribeAiChatThread,
  updateAiChatThread,
} from "../api";
import {
  AI_CHAT_SKILL_MARKER,
  buildThreadCreateInput,
  buildTurnInput,
  chatPrimaryAction,
  createAiSnapshotRefreshQueue,
  needsDangerConfirmation,
  normalizeChatSelection,
  parseAiChatComposerFragment,
  patchAiChatSnapshot,
  reasoningEffortForModel,
} from "../aiChatState";
import type {
  AiChatCatalog,
  AiChatEvent,
  AiChatAttachmentInput,
  AiChatModel,
  AiChatRun,
  AiChatSandbox,
  AiChatSkill,
  AiChatThread,
  AiChatThreadSnapshot,
} from "../types";
import { LinearIcon } from "./LinearIcon";
import {
  MessageTimeline,
  SkillReference,
  eventSkillIds,
  skillDisplayName,
} from "./AiChatMessages";

export const AI_CHAT_UNAVAILABLE_ERROR = Symbol("ai-chat-unavailable");
export type AiChatError = string | typeof AI_CHAT_UNAVAILABLE_ERROR;

export function messageFor(error: unknown): AiChatError {
  return error instanceof Error ? error.message : AI_CHAT_UNAVAILABLE_ERROR;
}

export interface ConversationViewProps {
  available: boolean;
  projectId: string | null;
  issueId: string | null;
  /** null 表示草稿态（还没建 thread），不要用它做 key，否则草稿转正时会卸载输入框 */
  threadId: string | null;
  /** 外壳正在删这条 thread，输入框禁用 */
  deleting: boolean;
  /** 错误的单一真源在外壳，这里只渲染 */
  error: AiChatError | null;
  /** 打开时预填的输入框文本（重试、从卡片带过来的问题） */
  initialComposerText?: string | null;
  /** 只有任务对话弹窗传 true：有 running run 时输入框只读（规格 §7.4） */
  readOnlyWhileRunning?: boolean;
  onError: (error: AiChatError | null) => void;
  /** 草稿转正，把新 id 交回外壳，外壳负责设成当前选中 */
  onThreadCreated: (threadId: string) => void;
  /** 设置保存、状态变化后同步外壳的 thread 列表（原 replaceThread:1170） */
  onThreadUpdate: (thread: AiChatThread) => void;
  /** 原 observeRunTransitions:1177 的未读判定挪到外壳 */
  onRunsObserved: (runs: AiChatRun[]) => void;
  /** ESC 或关闭按钮：外壳决定是收起面板还是关弹窗 */
  onRequestClose: () => void;
}

type MenuName = "model" | "model-list" | "effort-list" | "sandbox" | null;
type PendingDangerInput = {
  message: string;
  skillIds: string[];
  attachments: AiChatAttachmentInput[];
  clearSubmittedDraft: boolean;
};
type ComposerAttachment = AiChatAttachmentInput & {
  id: string;
  previewUrl?: string;
};
type ComposerSkillToken = {
  key: string;
  id: string;
  element: HTMLSpanElement;
};
type ComposerSkillQuery = {
  query: string;
};
type ComposerBeforeInput = {
  container: Node;
  offset: number;
  text: string;
};

const SKILL_MARKER = AI_CHAT_SKILL_MARKER;
const COMPOSER_FRAGMENT_MIME = "application/x-codex-taskboard-composer-fragment";
const COMPOSER_HTML_BLOCKS = new Set([
  "ADDRESS",
  "ARTICLE",
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "P",
  "PRE",
  "SECTION",
]);
const COMPOSER_HTML_IGNORED = new Set(["SCRIPT", "STYLE", "SVG"]);
const SANDBOX_LABELS: Record<AiChatSandbox, readonly [string, string]> = {
  "read-only": ["请求批准", "Ask for approval"],
  "workspace-write": ["替我审批", "Approve selected actions"],
  "danger-full-access": ["完全访问权限", "Full access"],
};
const SANDBOX_DESCRIPTIONS: Record<AiChatSandbox, readonly [string, string]> = {
  "read-only": ["编辑外部文件和使用互联网时始终询问", "Always ask before editing external files or using the internet"],
  "workspace-write": ["仅对检测到的风险操作请求批准", "Ask only for operations that are detected as risky"],
  "danger-full-access": ["不受限制地访问互联网和您电脑上的任何文件", "Access the internet and any file on your computer without restrictions"],
};
const SANDBOX_ICONS: Record<AiChatSandbox, "hand" | "terminal" | "shieldAlert"> = {
  "read-only": "hand",
  "workspace-write": "terminal",
  "danger-full-access": "shieldAlert",
};
const EFFORT_LABELS: Record<string, readonly [string, string]> = {
  low: ["低", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  xhigh: ["极高", "Extra high"],
  max: ["最高", "Maximum"],
  ultra: ["极高", "Ultra"],
};

function modelDisplayName(value: string): string {
  return value.replace(/^GPT-/i, "").replaceAll("-", " ");
}

function eventHasAttachments(event: AiChatEvent): boolean {
  return Array.isArray(event.data?.attachments) && event.data.attachments.length > 0;
}

function isAiChatSandbox(value: string): value is AiChatSandbox {
  return value === "read-only"
    || value === "workspace-write"
    || value === "danger-full-access";
}

function serializeComposer(root: HTMLElement): { message: string; skillIds: string[] } {
  let message = "";
  const skillIds: string[] = [];
  const appendText = (value: string) => {
    message += value.replaceAll("\u200B", "");
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent ?? "");
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const skillId = node.dataset.skillId;
    if (skillId) {
      message += SKILL_MARKER;
      skillIds.push(skillId);
      return;
    }
    if (node.tagName === "BR") {
      message += "\n";
      return;
    }
    const isBlock = node.tagName === "DIV" || node.tagName === "P";
    if (isBlock && message && !message.endsWith("\n")) message += "\n";
    for (const child of node.childNodes) visit(child);
    if (isBlock && node.nextSibling && !message.endsWith("\n")) message += "\n";
  };
  for (const child of root.childNodes) visit(child);
  return { message, skillIds };
}

function selectedComposerFragment(root: HTMLElement): {
  message: string;
  skillIds: string[];
  range: Range;
} | null {
  const selection = root.ownerDocument.getSelection();
  const selectionRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (
    !selection
    || selection.isCollapsed
    || !selectionRange
    || !root.contains(selectionRange.commonAncestorContainer)
  ) {
    return null;
  }
  const skillReferenceAt = (node: Node): HTMLElement | null => {
    const element = node instanceof HTMLElement ? node : node.parentElement;
    const composerToken = element?.closest<HTMLElement>(".ai-chat-composer-skill-token") ?? null;
    if (composerToken && root.contains(composerToken)) return composerToken;
    const reference = element?.closest<HTMLElement>("[data-skill-id]") ?? null;
    return reference && root.contains(reference) ? reference : null;
  };
  const copyRange = selectionRange.cloneRange();
  const startSkill = skillReferenceAt(copyRange.startContainer);
  const endSkill = skillReferenceAt(copyRange.endContainer);
  if (startSkill) copyRange.setStartBefore(startSkill);
  if (endSkill) copyRange.setEndAfter(endSkill);
  const wrapper = root.ownerDocument.createElement("div");
  wrapper.append(copyRange.cloneContents());
  const fragment = serializeComposer(wrapper);
  return fragment.message ? { ...fragment, range: copyRange } : null;
}

function composerMarkerCount(message: string): number {
  return message.split(SKILL_MARKER).length - 1;
}

function canonicalComposerFragment(
  fragment: { message: string; skillIds: string[] },
  skillsById: Map<string, AiChatSkill>,
): string {
  let index = 0;
  return fragment.message.replaceAll(SKILL_MARKER, () => {
    const skillId = fragment.skillIds[index] ?? "";
    index += 1;
    const skill = skillsById.get(skillId);
    return skill ? `[$${skill.id}](${skill.path})` : SKILL_MARKER;
  });
}

function composerFragmentHtml(
  fragment: { message: string; skillIds: string[] },
  skillsById: Map<string, AiChatSkill>,
  document: Document,
): string {
  const wrapper = document.createElement("div");
  const parts = fragment.message.split(SKILL_MARKER);
  parts.forEach((part, index) => {
    if (index > 0) {
      const skill = skillsById.get(fragment.skillIds[index - 1] ?? "");
      if (skill) {
        const link = document.createElement("a");
        link.setAttribute("href", skill.path);
        link.textContent = skillDisplayName(skill);
        wrapper.append(link);
      } else {
        wrapper.append(SKILL_MARKER);
      }
    }
    const lines = part.split("\n");
    lines.forEach((line, lineIndex) => {
      if (lineIndex > 0) wrapper.append(document.createElement("br"));
      wrapper.append(line);
    });
  });
  return wrapper.innerHTML;
}

function writeSkillFragmentToClipboard(
  event: ReactClipboardEvent<HTMLElement>,
  fragment: { message: string; skillIds: string[] },
  skillsById: Map<string, AiChatSkill>,
): boolean {
  if (
    fragment.skillIds.length === 0
    || !fragment.skillIds.every((skillId) => skillsById.has(skillId))
  ) {
    return false;
  }
  event.preventDefault();
  event.clipboardData.setData(COMPOSER_FRAGMENT_MIME, JSON.stringify({
    message: fragment.message,
    skillIds: fragment.skillIds,
  }));
  event.clipboardData.setData("text/plain", canonicalComposerFragment(fragment, skillsById));
  event.clipboardData.setData(
    "text/html",
    composerFragmentHtml(fragment, skillsById, event.currentTarget.ownerDocument),
  );
  return true;
}

function decodedSkillPath(href: string): string | null {
  const raw = href.trim();
  if (!raw) return null;
  try {
    if (raw.startsWith("file:")) return decodeURIComponent(new URL(raw).pathname);
    if (!raw.startsWith("/")) return null;
    return decodeURIComponent(raw.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
}

function composerFragmentFromHtml(
  html: string,
  skills: AiChatSkill[],
): { message: string; skillIds: string[] } | null {
  if (!html || skills.length === 0) return null;
  const document = new DOMParser().parseFromString(html, "text/html");
  const skillsByPath = new Map(skills.map((skill) => [skill.path, skill]));
  const skillIds: string[] = [];
  let message = "";
  let matchedSkill = false;
  const appendText = (value: string) => {
    message += value.replaceAll(SKILL_MARKER, "\uFFFD");
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (COMPOSER_HTML_IGNORED.has(element.tagName)) return;
    if (element.tagName === "A") {
      const path = decodedSkillPath(element.getAttribute("href") ?? "");
      const skill = path?.endsWith("/SKILL.md") ? skillsByPath.get(path) : null;
      if (skill) {
        message += SKILL_MARKER;
        skillIds.push(skill.id);
        matchedSkill = true;
        return;
      }
    }
    if (element.tagName === "BR") {
      message += "\n";
      return;
    }
    const isBlock = COMPOSER_HTML_BLOCKS.has(element.tagName);
    if (isBlock && message && !message.endsWith("\n")) message += "\n";
    for (const child of element.childNodes) visit(child);
    if (isBlock && element.nextSibling && !message.endsWith("\n")) message += "\n";
  };
  for (const child of document.body.childNodes) visit(child);
  return matchedSkill ? { message, skillIds } : null;
}

function composerFragmentFromPlainText(
  text: string,
  skills: AiChatSkill[],
): { message: string; skillIds: string[] } | null {
  if (!text || skills.length === 0) return null;
  const skillsByPath = new Map(skills.map((skill) => [skill.path, skill]));
  const skillIds: string[] = [];
  let message = "";
  let cursor = 0;
  const referencePattern = /\[\$([^\]\r\n]+)\]\((\/[^)\r\n]*\/SKILL\.md)\)/g;
  for (const match of text.matchAll(referencePattern)) {
    const path = decodedSkillPath(match[2]);
    const skill = path ? skillsByPath.get(path) : null;
    if (!skill || skill.id !== match[1]) continue;
    message += text.slice(cursor, match.index).replaceAll(SKILL_MARKER, "\uFFFD");
    message += SKILL_MARKER;
    skillIds.push(skill.id);
    cursor = (match.index ?? 0) + match[0].length;
  }
  if (skillIds.length === 0) return null;
  message += text.slice(cursor).replaceAll(SKILL_MARKER, "\uFFFD");
  return { message, skillIds };
}

function composerSkillQueryAt(
  root: HTMLElement,
  focusNode: Text,
  focusOffset: number,
): { query: string; range: Range } | null {
  if (!root.contains(focusNode)) return null;
  const rawPrefix = (focusNode.textContent ?? "").slice(0, focusOffset);
  const prefix = rawPrefix.replaceAll("\u200B", "");
  const match = /(?:^|\s)@([^\s@]*)$/.exec(prefix);
  if (!match) return null;
  const at = rawPrefix.lastIndexOf("@");
  const range = root.ownerDocument.createRange();
  range.setStart(focusNode, at);
  range.setEnd(focusNode, focusOffset);
  return { query: match[1].toLocaleLowerCase(), range };
}

function composerSkillQuery(root: HTMLElement): { query: string; range: Range } | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || !selection.isCollapsed || selection.focusNode?.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  return composerSkillQueryAt(root, selection.focusNode as Text, selection.focusOffset);
}

function composerSkillQueryAfterInput(
  root: HTMLElement,
  beforeInput: ComposerBeforeInput,
): { query: string; range: Range } | null {
  if (beforeInput.container.nodeType === Node.TEXT_NODE) {
    const textNode = beforeInput.container as Text;
    return composerSkillQueryAt(
      root,
      textNode,
      Math.min(beforeInput.offset + beforeInput.text.length, textNode.length),
    );
  }
  if (!(beforeInput.container instanceof HTMLElement) || !root.contains(beforeInput.container)) {
    return null;
  }
  const insertedNode = beforeInput.container.childNodes[beforeInput.offset];
  if (insertedNode?.nodeType !== Node.TEXT_NODE) return null;
  return composerSkillQueryAt(
    root,
    insertedNode as Text,
    Math.min(beforeInput.text.length, insertedNode.textContent?.length ?? 0),
  );
}

function tokenBeforeComposerCaret(root: HTMLElement): HTMLElement | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || !selection.isCollapsed || !selection.focusNode) return null;
  const focusNode = selection.focusNode;
  let candidate: ChildNode | null = null;
  if (focusNode.nodeType === Node.TEXT_NODE) {
    const prefix = (focusNode.textContent ?? "").slice(0, selection.focusOffset);
    if (prefix.replaceAll("\u200B", "").length > 0) return null;
    candidate = focusNode.previousSibling;
  } else if (focusNode instanceof HTMLElement) {
    candidate = focusNode.childNodes[selection.focusOffset - 1] ?? null;
  }
  while (
    candidate?.nodeType === Node.TEXT_NODE
    && !(candidate.textContent ?? "").replaceAll("\u200B", "")
  ) {
    candidate = candidate.previousSibling;
  }
  return candidate instanceof HTMLElement && candidate.dataset.skillId ? candidate : null;
}

export function ConversationView({
  available,
  projectId,
  issueId,
  threadId,
  deleting,
  error,
  initialComposerText,
  onError,
  onThreadCreated,
  onThreadUpdate,
  onRunsObserved,
  onRequestClose,
}: ConversationViewProps) {
  const { text } = useTaskboardI18n();
  const [snapshot, setSnapshot] = useState<AiChatThreadSnapshot | null>(null);
  const [catalog, setCatalog] = useState<AiChatCatalog | null>(null);
  const [catalogLoadedProjectId, setCatalogLoadedProjectId] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<AiChatError | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [skillMention, setSkillMention] = useState<ComposerSkillQuery | null>(null);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [composerSkillTokens, setComposerSkillTokens] = useState<ComposerSkillToken[]>([]);
  const [pendingDangerInput, setPendingDangerInput] = useState<PendingDangerInput | null>(null);
  const [menu, setMenu] = useState<MenuName>(null);
  const [draftModel, setDraftModel] = useState("");
  const [draftEffort, setDraftEffort] = useState("");
  const [draftSandbox, setDraftSandbox] = useState<AiChatSandbox>("workspace-write");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const skillMentionRangeRef = useRef<Range | null>(null);
  const composerBeforeInputRef = useRef<ComposerBeforeInput | null>(null);
  const skillMenuRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const selectedThreadRef = useRef(threadId);
  const snapshotRequestRef = useRef(0);
  const snapshotLoadingRequestRef = useRef(0);
  const consumedInitialComposerTextRef = useRef<string | null>(null);
  const dangerConfirmOpen = pendingDangerInput !== null;

  useEffect(() => {
    selectedThreadRef.current = threadId;
  }, [threadId]);

  const loadSnapshot = useCallback(async (targetThreadId: string, quiet = false) => {
    const requestId = ++snapshotRequestRef.current;
    if (!quiet) {
      snapshotLoadingRequestRef.current = requestId;
      setLoading(true);
    }
    try {
      const next = await getAiChatThread(targetThreadId);
      if (requestId !== snapshotRequestRef.current || selectedThreadRef.current !== targetThreadId) return;
      setSnapshot(next);
      onThreadUpdate(next.thread);
      onRunsObserved(next.runs);
      if (!quiet) onError(null);
    } catch (nextError) {
      if (
        !quiet
        && requestId === snapshotRequestRef.current
        && selectedThreadRef.current === targetThreadId
      ) onError(messageFor(nextError));
    } finally {
      if (!quiet && requestId === snapshotLoadingRequestRef.current) setLoading(false);
    }
  }, [onError, onRunsObserved, onThreadUpdate]);

  const selectedHintRefreshQueue = useMemo(
    () => createAiSnapshotRefreshQueue((targetThreadId) => loadSnapshot(targetThreadId, true)),
    [loadSnapshot],
  );
  useEffect(() => () => selectedHintRefreshQueue.clear(), [selectedHintRefreshQueue]);

  useEffect(() => {
    setSnapshot(null);
    if (!threadId) return;
    let initialPending = true;
    let refreshQueued = false;
    let disposed = false;
    void loadSnapshot(threadId).finally(() => {
      initialPending = false;
      if (refreshQueued && !disposed) {
        void selectedHintRefreshQueue.request(threadId);
      }
    });
    const unsubscribe = subscribeAiChatThread(
      threadId,
      () => {
        if (initialPending) refreshQueued = true;
        else void selectedHintRefreshQueue.request(threadId);
      },
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [loadSnapshot, selectedHintRefreshQueue, threadId]);

  const catalogProjectId = snapshot?.thread.origin.projectId ?? projectId;
  const activeCatalog = catalogLoadedProjectId === catalogProjectId ? catalog : null;
  useEffect(() => {
    if (!available || !catalogProjectId) {
      setCatalog(null);
      setCatalogLoadedProjectId(null);
      setCatalogError(null);
      return;
    }
    const controller = new AbortController();
    setCatalog(null);
    setCatalogLoadedProjectId(null);
    setCatalogError(null);
    void getAiChatCatalog(catalogProjectId, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setCatalog(next);
        setCatalogLoadedProjectId(catalogProjectId);
        setCatalogError(null);
      },
      (nextError) => {
        if (controller.signal.aborted) return;
        if ((nextError as Error).name !== "AbortError") {
          setCatalog(null);
          setCatalogLoadedProjectId(null);
          setCatalogError(messageFor(nextError));
        }
      },
    );
    return () => controller.abort();
  }, [available, catalogProjectId]);

  const restoreDraftSettings = useCallback((thread: AiChatThread) => {
    setDraftModel(thread.model);
    setDraftEffort(thread.reasoningEffort);
    setDraftSandbox(thread.sandbox);
  }, []);

  useEffect(() => {
    const thread = snapshot?.thread;
    if (thread) {
      restoreDraftSettings(thread);
      return;
    }
    const normalized = normalizeChatSelection(activeCatalog?.models ?? [], draftModel, draftEffort);
    if (normalized) {
      setDraftModel(normalized.model);
      setDraftEffort(normalized.reasoningEffort);
    }
    const sandbox = threadId === null && activeCatalog?.sandboxes.includes(draftSandbox)
      ? draftSandbox
      : activeCatalog?.sandboxes.find(
          (candidate): candidate is AiChatSandbox => candidate === "workspace-write",
        ) ?? activeCatalog?.sandboxes.find(isAiChatSandbox);
    if (sandbox) setDraftSandbox(sandbox);
  }, [activeCatalog, threadId, restoreDraftSettings, snapshot?.thread.id]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [snapshot?.events.length, snapshot?.thread.status]);

  useEffect(() => {
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      if (dangerConfirmOpen) setPendingDangerInput(null);
      else if (skillMention) setSkillMention(null);
      else if (menu) setMenu(null);
      else onRequestClose();
    }
    document.addEventListener("keydown", closeWithEscape, true);
    return () => document.removeEventListener("keydown", closeWithEscape, true);
  }, [dangerConfirmOpen, menu, onRequestClose, skillMention]);

  const visibleSkills = useMemo(
    () => (activeCatalog?.skills ?? []).filter((skill) => (
      skill.id !== "manage-taskboard"
      && !skill.id.endsWith(":manage-taskboard")
      && (
        !skillMention?.query
        || skill.label.toLocaleLowerCase().includes(skillMention.query)
        || skill.id.toLocaleLowerCase().includes(skillMention.query)
        || skill.description.toLocaleLowerCase().includes(skillMention.query)
        || skill.path.toLocaleLowerCase().includes(skillMention.query)
      )
    )),
    [activeCatalog?.skills, skillMention?.query],
  );
  const selectedModel = activeCatalog?.models.find((model) => model.slug === draftModel) ?? null;
  const availableSandboxes = (activeCatalog?.sandboxes ?? []).filter(isAiChatSandbox);
  const currentRun = snapshot?.thread.currentRun
    ?? snapshot?.runs.find((run) => run.status === "running")
    ?? null;
  const visibleError = error ?? catalogError;
  const composerBlocked = Boolean(threadId && deleting);
  const sendBlocked = loading
    || settingsSaving
    || composerBlocked
    || Boolean(threadId && !snapshot);
  const threadSettingsBlocked = loading || Boolean(threadId && !snapshot);
  const attachmentBlocked = composerBlocked;
  const primaryAction = chatPrimaryAction(
    snapshot?.thread.status ?? "idle",
    draft,
    sendBlocked,
    attachments.length > 0,
  );
  const lastUserEvent = snapshot?.thread.status === "failed"
    ? [...snapshot.events].reverse().find((event) => (
        event.role === "user"
        || event.type === "user"
        || event.type === "user_message"
      )) ?? null
    : null;
  const retryableUserEvent = lastUserEvent && !eventHasAttachments(lastUserEvent)
    ? lastUserEvent
    : null;

  useEffect(() => {
    setSelectedSkillIndex(0);
  }, [skillMention?.query]);

  useEffect(() => {
    setSelectedSkillIndex((current) => (
      visibleSkills.length === 0 ? 0 : Math.min(current, visibleSkills.length - 1)
    ));
  }, [visibleSkills.length]);

  useEffect(() => {
    const option = skillMenuRef.current?.querySelector<HTMLElement>(
      `[data-skill-index="${selectedSkillIndex}"]`,
    );
    option?.scrollIntoView({ block: "nearest" });
  }, [selectedSkillIndex, skillMention?.query, visibleSkills.length]);

  useEffect(() => {
    if (attachmentBlocked) setAttachmentDragActive(false);
  }, [attachmentBlocked]);

  function resetComposer() {
    editorRef.current?.replaceChildren();
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    setDraft("");
    setAttachments([]);
    setSkillIds([]);
    setComposerSkillTokens([]);
    setSkillMention(null);
    setPendingDangerInput(null);
    setAttachmentDragActive(false);
    skillMentionRangeRef.current = null;
  }

  useEffect(() => {
    setSnapshot((current) => current?.thread.id === threadId ? current : (threadId ? current : null));
    resetComposer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  useEffect(() => {
    const editor = editorRef.current;
    if (
      !editor
      || initialComposerText === null
      || initialComposerText === undefined
      || consumedInitialComposerTextRef.current === initialComposerText
    ) return;
    consumedInitialComposerTextRef.current = initialComposerText;
    editor.replaceChildren(document.createTextNode(initialComposerText));
    setDraft(initialComposerText);
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [initialComposerText]);

  async function createThreadForDraftOrigin(): Promise<AiChatThread | null> {
    const origin = threadId === null && projectId ? { projectId, issueId } : null;
    const input = buildThreadCreateInput(origin?.projectId ?? "", origin?.issueId ?? null);
    if (!input) {
      onError(text(
        "请先进入一个已映射的项目，再新建对话",
        "Open a mapped project before you start a new chat.",
      ));
      return null;
    }
    const inheritedSettings = {
      model: draftModel,
      reasoningEffort: draftEffort,
      sandbox: draftSandbox,
    };
    setLoading(true);
    try {
      const targetCatalog = catalogLoadedProjectId === input.projectId && activeCatalog
        ? activeCatalog
        : await getAiChatCatalog(input.projectId);
      const normalized = normalizeChatSelection(
        targetCatalog.models,
        inheritedSettings.model,
        inheritedSettings.reasoningEffort,
      );
      const sandbox = targetCatalog.sandboxes.includes(inheritedSettings.sandbox)
        ? inheritedSettings.sandbox
        : targetCatalog.sandboxes.find(
          (candidate): candidate is AiChatSandbox => candidate === "workspace-write",
        ) ?? targetCatalog.sandboxes.find(isAiChatSandbox) ?? inheritedSettings.sandbox;
      const settings = {
        model: normalized?.model ?? inheritedSettings.model,
        reasoningEffort: normalized?.reasoningEffort ?? inheritedSettings.reasoningEffort,
        sandbox,
      };
      const thread = await createAiChatThread({
        ...input,
        ...settings,
      });
      onThreadUpdate(thread);
      onThreadCreated(thread.id);
      setSnapshot({ thread, events: [], runs: [] });
      onError(null);
      return thread;
    } catch (nextError) {
      onError(messageFor(nextError));
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function saveThreadSettings(changes: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: AiChatSandbox;
  }) {
    const previousThread = snapshot?.thread;
    if (!previousThread) return;
    const threadId = previousThread.id;
    setSettingsSaving(true);
    try {
      const thread = await updateAiChatThread(threadId, changes);
      setSnapshot((current) => patchAiChatSnapshot(current, threadId, thread));
      onThreadUpdate(thread);
      if (selectedThreadRef.current === threadId) onError(null);
    } catch (nextError) {
      if (selectedThreadRef.current === threadId) {
        restoreDraftSettings(previousThread);
        onError(messageFor(nextError));
      }
    } finally {
      setSettingsSaving(false);
    }
  }

  async function chooseModel(model: AiChatModel) {
    const reasoningEffort = reasoningEffortForModel(model, draftEffort);
    setMenu(null);
    setDraftModel(model.slug);
    setDraftEffort(reasoningEffort);
    await saveThreadSettings({
      model: model.slug,
      reasoningEffort,
    });
  }

  async function chooseEffort(reasoningEffort: string) {
    setMenu(null);
    setDraftEffort(reasoningEffort);
    await saveThreadSettings({ reasoningEffort });
  }

  async function chooseSandbox(sandbox: AiChatSandbox) {
    setMenu(null);
    setDraftSandbox(sandbox);
    await saveThreadSettings({ sandbox });
  }

  function syncComposerState() {
    const editor = editorRef.current;
    if (!editor) return;
    const next = serializeComposer(editor);
    setDraft(next.message);
    setSkillIds(next.skillIds);
    setComposerSkillTokens((current) => current.filter((token) => editor.contains(token.element)));
    if (!next.message && editor.childNodes.length > 0) editor.replaceChildren();
  }

  function rememberComposerBeforeInput(event: InputEvent) {
    const editor = editorRef.current;
    const selection = editor?.ownerDocument.getSelection();
    if (
      !editor
      || !selection
      || !selection.isCollapsed
      || !selection.focusNode
      || !editor.contains(selection.focusNode)
      || event.inputType !== "insertText"
      || event.data === null
    ) {
      composerBeforeInputRef.current = null;
      return;
    }
    composerBeforeInputRef.current = {
      container: selection.focusNode,
      offset: selection.focusOffset,
      text: event.data,
    };
  }

  function updateComposerSkillQuery(fromInput = false) {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.ownerDocument.activeElement !== editor) {
      composerBeforeInputRef.current = null;
      skillMentionRangeRef.current = null;
      setSkillMention(null);
      return;
    }
    const beforeInput = fromInput ? composerBeforeInputRef.current : null;
    const next = (
      beforeInput ? composerSkillQueryAfterInput(editor, beforeInput) : null
    ) ?? composerSkillQuery(editor);
    composerBeforeInputRef.current = null;
    skillMentionRangeRef.current = next?.range ?? null;
    setSkillMention(next ? { query: next.query } : null);
  }

  function removeComposerSkillToken(element: HTMLElement) {
    const editor = editorRef.current;
    const parent = element.parentNode;
    if (!editor || !parent) return;
    const nextSibling = element.nextSibling;
    const childIndex = Array.prototype.indexOf.call(parent.childNodes, element) as number;
    if (nextSibling?.nodeType === Node.TEXT_NODE && nextSibling.textContent?.startsWith("\u200B")) {
      nextSibling.textContent = nextSibling.textContent.slice(1);
    }
    element.remove();
    setComposerSkillTokens((current) => current.filter((token) => token.element !== element));
    const selection = editor.ownerDocument.getSelection();
    const range = editor.ownerDocument.createRange();
    if (nextSibling?.isConnected && nextSibling.nodeType === Node.TEXT_NODE) {
      range.setStart(nextSibling, 0);
    } else {
      range.setStart(parent, Math.min(childIndex, parent.childNodes.length));
    }
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    syncComposerState();
    editor.focus();
  }

  function insertComposerFragment(
    fragment: { message: string; skillIds: string[] },
    targetRange?: Range,
  ): boolean {
    const editor = editorRef.current;
    if (!editor || composerMarkerCount(fragment.message) !== fragment.skillIds.length) return false;
    const skillsById = new Map((activeCatalog?.skills ?? []).map((skill) => [skill.id, skill]));
    if (!fragment.skillIds.every((skillId) => skillsById.has(skillId))) return false;
    const selection = editor.ownerDocument.getSelection();
    const range = targetRange ?? (selection?.rangeCount ? selection.getRangeAt(0) : null);
    if (!range || !editor.contains(range.commonAncestorContainer)) return false;

    const content = editor.ownerDocument.createDocumentFragment();
    const newTokens: ComposerSkillToken[] = [];
    let messageOffset = 0;
    let skillIndex = 0;
    for (
      let markerOffset = fragment.message.indexOf(SKILL_MARKER);
      markerOffset >= 0;
      markerOffset = fragment.message.indexOf(SKILL_MARKER, messageOffset)
    ) {
      if (markerOffset > messageOffset) {
        content.append(editor.ownerDocument.createTextNode(
          fragment.message.slice(messageOffset, markerOffset),
        ));
      }
      const skillId = fragment.skillIds[skillIndex];
      const skill = skillsById.get(skillId);
      if (!skill) return false;
      const tokenElement = editor.ownerDocument.createElement("span");
      tokenElement.className = "ai-chat-composer-skill-token";
      tokenElement.dataset.skillId = skill.id;
      tokenElement.contentEditable = "false";
      tokenElement.title = skillDisplayName(skill);
      content.append(tokenElement, editor.ownerDocument.createTextNode("\u200B"));
      newTokens.push({ key: crypto.randomUUID(), id: skill.id, element: tokenElement });
      skillIndex += 1;
      messageOffset = markerOffset + SKILL_MARKER.length;
    }
    if (messageOffset < fragment.message.length) {
      content.append(editor.ownerDocument.createTextNode(fragment.message.slice(messageOffset)));
    }
    if (!content.lastChild) return false;

    const lastNode = content.lastChild;
    range.deleteContents();
    range.insertNode(content);
    if (lastNode.nodeType === Node.TEXT_NODE) {
      range.setStart(lastNode, lastNode.textContent?.length ?? 0);
    } else {
      range.setStartAfter(lastNode);
    }
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    syncComposerState();
    setComposerSkillTokens((current) => [...current, ...newTokens]);
    setSkillMention(null);
    skillMentionRangeRef.current = null;
    editor.focus();
    return true;
  }

  function selectSkill(skill: AiChatSkill) {
    const editor = editorRef.current;
    const range = skillMentionRangeRef.current;
    if (!skillMention || !editor || !range) return;
    insertComposerFragment({ message: SKILL_MARKER, skillIds: [skill.id] }, range);
  }

  function realSkillIdsForMessage(): string[] {
    return skillIds;
  }

  async function startMessage(
    message: string,
    dangerConfirmed: boolean,
    boundSkillIds?: string[],
    clearSubmittedDraft = true,
    boundAttachments?: AiChatAttachmentInput[],
  ) {
    if (sendBlocked) return;
    const trimmed = message.trim();
    const submittedSkillIds = boundSkillIds ?? [...realSkillIdsForMessage()];
    const messageAttachments = boundAttachments ?? attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      dataBase64: attachment.dataBase64,
    }));
    if (!trimmed && messageAttachments.length === 0) return;
    let thread = snapshot?.thread ?? null;
    const creatingThread = !thread;
    const messageSandbox = thread?.sandbox ?? draftSandbox;
    if (needsDangerConfirmation(messageSandbox, dangerConfirmed)) {
      setPendingDangerInput({
        message: trimmed,
        skillIds: submittedSkillIds,
        attachments: messageAttachments,
        clearSubmittedDraft,
      });
      return;
    }
    if (creatingThread && clearSubmittedDraft) resetComposer();
    if (!thread) thread = await createThreadForDraftOrigin();
    if (!thread) return;
    const messageSkillIds = (
      boundSkillIds !== undefined || catalogLoadedProjectId === thread.origin.projectId
    ) ? submittedSkillIds : [];
    setPendingDangerInput(null);
    onError(null);
    try {
      const turnInput = buildTurnInput(
        trimmed,
        messageSkillIds,
        dangerConfirmed,
        messageAttachments,
      );
      if (clearSubmittedDraft && !creatingThread) {
        resetComposer();
      }
      const run = await startAiChatTurn(thread.id, turnInput);
      onRunsObserved([run]);
      setSnapshot((current) => current?.thread.id === thread.id ? {
          ...current,
          thread: {
            ...current.thread,
            status: "running",
            currentRun: run,
            latestTodo: null,
          },
          runs: [run, ...current.runs.filter((candidate) => candidate.id !== run.id)],
        } : current);
      onThreadUpdate({ ...thread, status: "running", currentRun: run, latestTodo: null });
      if (selectedThreadRef.current === thread.id) {
        void selectedHintRefreshQueue.request(thread.id);
      }
    } catch (nextError) {
      if (selectedThreadRef.current === thread.id) onError(messageFor(nextError));
      if (selectedThreadRef.current === thread.id) {
        void selectedHintRefreshQueue.request(thread.id);
      }
    }
  }

  function attachmentFiles(files: FileList | File[]): File[] {
    return Array.from(files);
  }

  async function addAttachments(files: File[]) {
    if (attachmentBlocked) return;
    const acceptedFiles = attachmentFiles(files);
    if (acceptedFiles.length === 0) return;
    try {
      const nextAttachments = await Promise.all(acceptedFiles.map((file, index) => (
        new Promise<ComposerAttachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result !== "string") {
              reject(new Error(text(
                `无法读取附件 ${file.name}`,
                `Could not read attachment ${file.name}.`,
              )));
              return;
            }
            const separator = reader.result.indexOf(",");
            resolve({
              id: `${file.name}-${file.size}-${file.lastModified}-${Date.now()}-${index}`,
              filename: file.name,
              contentType: file.type || "application/octet-stream",
              dataBase64: reader.result.slice(separator + 1),
              ...(file.type.startsWith("image/") ? { previewUrl: reader.result } : {}),
            });
          };
          reader.onerror = () => reject(new Error(text(
            `无法读取附件 ${file.name}`,
            `Could not read attachment ${file.name}.`,
          )));
          reader.readAsDataURL(file);
        })
      )));
      setAttachments((current) => [...current, ...nextAttachments]);
      onError(null);
    } catch (nextError) {
      onError(messageFor(nextError));
    }
  }

  async function handleAttachmentSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = attachmentFiles(event.target.files ?? []);
    event.target.value = "";
    await addAttachments(files);
  }

  function hasDraggedFile(event: ReactDragEvent<HTMLDivElement>): boolean {
    return Array.from(event.dataTransfer.items).some((item) => (
      item.kind === "file"
    )) || event.dataTransfer.files.length > 0;
  }

  function handleAttachmentDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFile(event)) return;
    event.preventDefault();
    if (attachmentBlocked) return;
    setAttachmentDragActive(true);
  }

  function handleAttachmentDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!attachmentDragActive && !hasDraggedFile(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = attachmentBlocked ? "none" : "copy";
  }

  function handleAttachmentDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setAttachmentDragActive(false);
  }

  function handleAttachmentDrop(event: ReactDragEvent<HTMLDivElement>) {
    setAttachmentDragActive(false);
    const files = attachmentFiles(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    if (attachmentBlocked) return;
    void addAttachments(files);
  }

  function handleComposerCopy(event: ReactClipboardEvent<HTMLDivElement>) {
    const editor = editorRef.current;
    if (!editor) return;
    const fragment = selectedComposerFragment(editor);
    if (!fragment) return;
    const skillsById = new Map((activeCatalog?.skills ?? []).map((skill) => [skill.id, skill]));
    writeSkillFragmentToClipboard(event, fragment, skillsById);
  }

  function handleComposerCut(event: ReactClipboardEvent<HTMLDivElement>) {
    const editor = editorRef.current;
    if (!editor) return;
    const fragment = selectedComposerFragment(editor);
    if (!fragment) return;
    const skillsById = new Map((activeCatalog?.skills ?? []).map((skill) => [skill.id, skill]));
    if (!writeSkillFragmentToClipboard(event, fragment, skillsById)) return;

    const range = fragment.range;
    range.deleteContents();
    range.collapse(true);
    const { startContainer, startOffset } = range;
    let sentinel: Text | null = null;
    let sentinelOffset = 0;
    if (startContainer.nodeType === Node.TEXT_NODE) {
      const textNode = startContainer as Text;
      if (textNode.data[startOffset] === "\u200B") {
        sentinel = textNode;
        sentinelOffset = startOffset;
      } else if (
        startOffset === textNode.length
        && textNode.nextSibling?.nodeType === Node.TEXT_NODE
        && (textNode.nextSibling as Text).data.startsWith("\u200B")
      ) {
        sentinel = textNode.nextSibling as Text;
      }
    } else if (
      startContainer.nodeType === Node.ELEMENT_NODE
      && startContainer.childNodes[startOffset]?.nodeType === Node.TEXT_NODE
      && (startContainer.childNodes[startOffset] as Text).data.startsWith("\u200B")
    ) {
      sentinel = startContainer.childNodes[startOffset] as Text;
    }
    if (sentinel) {
      sentinel.deleteData(sentinelOffset, 1);
      if (!sentinel.data && sentinel !== startContainer) sentinel.remove();
    }

    syncComposerState();
    const selection = editor.ownerDocument.getSelection();
    selection?.removeAllRanges();
    if (range.startContainer === editor || editor.contains(range.startContainer)) {
      selection?.addRange(range);
    } else {
      const caret = editor.ownerDocument.createRange();
      caret.selectNodeContents(editor);
      caret.collapse(false);
      selection?.addRange(caret);
    }
    setSkillMention(null);
    skillMentionRangeRef.current = null;
    editor.focus();
  }

  function handleComposerPaste(event: ReactClipboardEvent<HTMLDivElement>) {
    if (attachmentBlocked) return;
    const files = attachmentFiles(event.clipboardData.files);
    event.preventDefault();
    if (files.length > 0) {
      void addAttachments(files);
      return;
    }
    const skills = activeCatalog?.skills ?? [];
    const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
    const internalFragment = parseAiChatComposerFragment(
      event.clipboardData.getData(COMPOSER_FRAGMENT_MIME),
      skillsById.keys(),
    );
    if (internalFragment && insertComposerFragment(internalFragment)) return;
    const htmlFragment = composerFragmentFromHtml(
      event.clipboardData.getData("text/html"),
      skills,
    );
    if (htmlFragment && insertComposerFragment(htmlFragment)) return;
    const clipboardText = event.clipboardData.getData("text/plain");
    const plainFragment = composerFragmentFromPlainText(clipboardText, skills);
    if (plainFragment && insertComposerFragment(plainFragment)) return;
    const plainText = clipboardText.replaceAll(SKILL_MARKER, "\uFFFD");
    if (plainText) insertComposerFragment({ message: plainText, skillIds: [] });
  }

  async function stopRun(run: AiChatRun | null) {
    if (!run) return;
    try {
      await interruptAiChatRun(run.id);
      if (selectedThreadRef.current === run.threadId) {
        void selectedHintRefreshQueue.request(run.threadId);
      }
    } catch (nextError) {
      if (selectedThreadRef.current === run.threadId) onError(messageFor(nextError));
    }
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (composerBlocked) return;
    if (event.key === "Enter" && event.shiftKey) return;
    if (event.key === "Backspace") {
      const token = editorRef.current ? tokenBeforeComposerCaret(editorRef.current) : null;
      if (token) {
        event.preventDefault();
        removeComposerSkillToken(token);
        return;
      }
    }
    if (skillMention && visibleSkills.length > 0 && event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedSkillIndex((current) => (current + 1) % visibleSkills.length);
      return;
    }
    if (skillMention && visibleSkills.length > 0 && event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedSkillIndex((current) => (
        (current - 1 + visibleSkills.length) % visibleSkills.length
      ));
      return;
    }
    if (event.key === "Enter" && skillMention && visibleSkills[selectedSkillIndex]) {
      event.preventDefault();
      selectSkill(visibleSkills[selectedSkillIndex]);
      return;
    }
    if (event.key === "Enter") {
      if (primaryAction === "stop") return;
      event.preventDefault();
      if (primaryAction === "send") void startMessage(draft, false);
    }
  }

  if (!available) return null;


  return (
    <div className="ai-conversation">
      <div
        className="ai-chat-messages"
        ref={messagesRef}
        aria-busy={loading}
        aria-live="polite"
      >
        {loading && !snapshot ? (
          <div className="ai-chat-empty">
            <span className="ai-chat-spinner" />
            {text("正在恢复对话…", "Restoring chat…")}
          </div>
        ) : snapshot ? (
          <>
            <MessageTimeline
              activeRunId={currentRun?.id ?? null}
              events={snapshot.events}
              skills={activeCatalog?.skills ?? []}
              onCopy={(event, skillsById) => {
                const fragment = selectedComposerFragment(event.currentTarget);
                if (fragment) writeSkillFragmentToClipboard(event, fragment, skillsById);
              }}
            />
            {snapshot.thread.status === "running" && (
              <div className="ai-chat-running" role="status">
                <span className="ai-chat-spinner" />
                {text("Codex 正在处理", "Codex is working")}
              </div>
            )}
            {retryableUserEvent && (
              <button
                className="ai-chat-retry"
                type="button"
                onClick={() => {
                  void startMessage(
                    retryableUserEvent.content,
                    false,
                    eventSkillIds(retryableUserEvent),
                    false,
                    [],
                  );
                }}
              >
                <LinearIcon name="recurrence" />
                {text("重试上一条消息", "Retry the previous message")}
              </button>
            )}
          </>
        ) : (
          <div className="ai-chat-empty">
            <LinearIcon name="conversation" />
            <strong>{projectId
              ? text("在当前项目中开始对话", "Start a chat in the current project")
              : text("打开一个历史对话", "Open a chat from history")}</strong>
            <p>{projectId
              ? text(
                "Codex 会在新对话创建时记住当前项目。",
                "Codex will remember the current project when it creates the new chat.",
              )
              : text("进入项目后可以新建对话。", "Open a project to start a new chat.")}</p>
          </div>
        )}
      </div>

      {visibleError && (
        <div className="ai-chat-error" role="alert">
          <LinearIcon name="alert" />
          <span>{visibleError === AI_CHAT_UNAVAILABLE_ERROR
            ? text("AI 对话暂时不可用", "AI chat is temporarily unavailable.")
            : visibleError}</span>
        </div>
      )}

      <div
        className={`ai-chat-composer${attachmentDragActive ? " is-attachment-drag-active" : ""}`}
        onDragEnter={handleAttachmentDragEnter}
        onDragOver={handleAttachmentDragOver}
        onDragLeave={handleAttachmentDragLeave}
        onDrop={handleAttachmentDrop}
      >
        {attachmentDragActive && (
          <div className="ai-chat-attachment-drop-hint" aria-hidden="true">
            {text("松开添加文件", "Drop files to add them")}
          </div>
        )}
        <div className="ai-chat-input-wrap">
          {attachments.length > 0 && (
            <div className="ai-chat-composer-attachments">
              {attachments.map((attachment) => (
                <div
                  className={`ai-chat-composer-attachment${attachment.previewUrl ? "" : " is-file"}`}
                  key={attachment.id}
                >
                  {attachment.previewUrl
                    ? <img src={attachment.previewUrl} alt="" />
                    : (
                      <span className="ai-chat-composer-file">
                        <LinearIcon name="file" />
                        <span>{attachment.filename}</span>
                      </span>
                    )}
                  <button
                    type="button"
                    aria-label={text(
                      `移除附件 ${attachment.filename}`,
                      `Remove attachment ${attachment.filename}`,
                    )}
                    title={text("移除附件", "Remove attachment")}
                    onClick={() => {
                      setAttachments((current) => current.filter((item) => item.id !== attachment.id));
                    }}
                  >
                    <LinearIcon name="close" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div
            ref={editorRef}
            className="ai-chat-composer-editor"
            contentEditable={!composerBlocked}
            data-placeholder={text("询问 Codex", "Ask Codex")}
            role="textbox"
            aria-label={text("发送给 Codex 的消息", "Message to Codex")}
            aria-multiline="true"
            suppressContentEditableWarning
            onBeforeInput={(event) => rememberComposerBeforeInput(event.nativeEvent as InputEvent)}
            onInput={() => {
              syncComposerState();
              updateComposerSkillQuery(true);
            }}
            onClick={(event) => {
              const token = (event.target as HTMLElement).closest<HTMLElement>(
                ".ai-chat-composer-skill-token",
              );
              if (token && event.currentTarget.contains(token)) {
                removeComposerSkillToken(token);
                return;
              }
              updateComposerSkillQuery();
            }}
            onKeyDown={handleComposerKeyDown}
            onKeyUp={(event) => {
              if (
                event.key === "ArrowLeft"
                || event.key === "ArrowRight"
                || event.key === "Home"
                || event.key === "End"
                || (!skillMention && (
                  event.key === "ArrowUp"
                  || event.key === "ArrowDown"
                ))
              ) updateComposerSkillQuery();
            }}
            onCompositionEnd={() => updateComposerSkillQuery()}
            onBlur={() => setSkillMention(null)}
            onCopy={handleComposerCopy}
            onCut={handleComposerCut}
            onPaste={handleComposerPaste}
          />
          {composerSkillTokens.map((token) => {
            const skill = activeCatalog?.skills.find((candidate) => candidate.id === token.id);
            return createPortal(
              <button
                type="button"
                aria-label={text(
                  `移除 Skill ${skill ? skillDisplayName(skill) : token.id}`,
                  `Remove Skill ${skill ? skillDisplayName(skill) : token.id}`,
                )}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => removeComposerSkillToken(token.element)}
              >
                <SkillReference skill={skill} skillId={token.id} />
              </button>,
              token.element,
              token.key,
            );
          })}
          {skillMention && visibleSkills.length > 0 && (
            <div
              ref={skillMenuRef}
              className="ai-chat-skill-menu"
              role="listbox"
              aria-label={text("可用 Skill", "Available Skills")}
            >
              {visibleSkills.map((skill, index) => (
                <button
                  className={index === selectedSkillIndex ? "is-selected" : undefined}
                  type="button"
                  role="option"
                  aria-selected={index === selectedSkillIndex}
                  data-skill-index={index}
                  key={skill.id}
                  onPointerDown={(event) => event.preventDefault()}
                  onPointerEnter={() => setSelectedSkillIndex(index)}
                  onClick={() => selectSkill(skill)}
                >
                  <LinearIcon name="project" />
                  <span>
                    <strong>{skillDisplayName(skill)}</strong>
                    {skill.description && <small>{skill.description}</small>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="ai-chat-composer-toolbar">
          <input
            ref={attachmentInputRef}
            className="ai-chat-attachment-input"
            type="file"
            multiple
            tabIndex={-1}
            onChange={(event) => void handleAttachmentSelection(event)}
          />
          <button
            className="ai-chat-attachment-button"
            type="button"
            aria-label={text("添加附件", "Add attachment")}
            title={text("添加附件", "Add attachment")}
            disabled={attachmentBlocked}
            onClick={() => attachmentInputRef.current?.click()}
          >
            <LinearIcon name="plus" />
          </button>
          <div className="ai-chat-menu-wrap ai-chat-permission-menu-wrap">
            <button
              className="ai-chat-permission-trigger"
              type="button"
              aria-haspopup="menu"
              aria-expanded={menu === "sandbox"}
              disabled={
                !activeCatalog
                || snapshot?.thread.status === "running"
                || settingsSaving
                || threadSettingsBlocked
              }
              onClick={() => setMenu((current) => current === "sandbox" ? null : "sandbox")}
            >
              <LinearIcon name={SANDBOX_ICONS[draftSandbox]} />
              {text(...SANDBOX_LABELS[draftSandbox])}
              <LinearIcon name="chevronDown" />
            </button>
            {menu === "sandbox" && (
              <div
                className="ai-chat-option-menu ai-chat-permission-menu"
                role="menu"
                aria-label={text("执行权限", "Execution permissions")}
              >
                <header>
                  <span>{text("应如何批准 Codex 操作？", "How should Codex operations be approved?")}</span>
                  <a
                    href="https://developers.openai.com/codex/security"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {text("了解更多", "Learn more")}
                  </a>
                </header>
                {availableSandboxes.map((sandbox) => (
                  <button
                    className={sandbox === "danger-full-access" ? "is-danger" : undefined}
                    type="button"
                    role="menuitemradio"
                    aria-checked={sandbox === draftSandbox}
                    key={sandbox}
                    onClick={() => void chooseSandbox(sandbox)}
                  >
                    <LinearIcon name={SANDBOX_ICONS[sandbox]} />
                    <span>
                      <strong>{text(...SANDBOX_LABELS[sandbox])}</strong>
                      <small>{text(...SANDBOX_DESCRIPTIONS[sandbox])}</small>
                    </span>
                    {sandbox === draftSandbox && <LinearIcon name="check" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <span className="ai-chat-toolbar-spacer" />
          <div className="ai-chat-menu-wrap ai-chat-model-menu-wrap">
            <button
              className="ai-chat-model-trigger"
              type="button"
              aria-haspopup="menu"
              aria-expanded={menu === "model" || menu === "model-list" || menu === "effort-list"}
              disabled={
                !activeCatalog
                || snapshot?.thread.status === "running"
                || settingsSaving
                || threadSettingsBlocked
              }
              onClick={() => setMenu((current) => (
                current === "model" || current === "model-list" || current === "effort-list"
                  ? null
                  : "model"
              ))}
            >
              <span>{modelDisplayName(
                selectedModel?.displayName ?? (draftModel || text("模型", "Model")),
              )}</span>
              <span className="ai-chat-model-effort">
                {EFFORT_LABELS[draftEffort]
                  ? text(...EFFORT_LABELS[draftEffort])
                  : draftEffort || text("推理", "Reasoning")}
              </span>
              <LinearIcon name="chevronDown" />
            </button>
            {menu === "model" && (
              <div
                className="ai-chat-option-menu ai-chat-config-menu"
                role="menu"
                aria-label={text("模型与推理强度", "Model and reasoning effort")}
              >
                <button type="button" onClick={() => setMenu("model-list")}>
                  <span>{text("模型", "Model")}</span>
                  <strong>{modelDisplayName(selectedModel?.displayName ?? draftModel)}</strong>
                  <LinearIcon name="chevronRight" />
                </button>
                <button type="button" onClick={() => setMenu("effort-list")}>
                  <span>{text("推理强度", "Reasoning effort")}</span>
                  <strong>{EFFORT_LABELS[draftEffort]
                    ? text(...EFFORT_LABELS[draftEffort])
                    : draftEffort}</strong>
                  <LinearIcon name="chevronRight" />
                </button>
              </div>
            )}
            {menu === "model-list" && (
              <div
                className="ai-chat-option-menu ai-chat-config-menu ai-chat-config-submenu ai-chat-model-list"
                role="menu"
                aria-label={text("选择模型", "Select model")}
              >
                <header>
                  <button
                    type="button"
                    aria-label={text("返回模型与推理强度", "Back to model and reasoning effort")}
                    onClick={() => setMenu("model")}
                  >
                    <LinearIcon name="chevronLeft" />
                  </button>
                  <strong>{text("模型", "Model")}</strong>
                </header>
                {(activeCatalog?.models ?? []).map((model) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={model.slug === draftModel}
                    key={model.slug}
                    onClick={() => void chooseModel(model)}
                  >
                    <span>
                      <strong>{modelDisplayName(model.displayName)}</strong>
                    </span>
                    {model.slug === draftModel && <LinearIcon name="check" />}
                  </button>
                ))}
              </div>
            )}
            {menu === "effort-list" && selectedModel && (
              <div
                className="ai-chat-option-menu ai-chat-config-menu ai-chat-config-submenu"
                role="menu"
                aria-label={text("选择推理强度", "Select reasoning effort")}
              >
                <header>
                  <button
                    type="button"
                    aria-label={text("返回模型与推理强度", "Back to model and reasoning effort")}
                    onClick={() => setMenu("model")}
                  >
                    <LinearIcon name="chevronLeft" />
                  </button>
                  <strong>{text("推理强度", "Reasoning effort")}</strong>
                </header>
                {selectedModel.supportedReasoningEfforts.map((effort) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={effort === draftEffort}
                    key={effort}
                    onClick={() => void chooseEffort(effort)}
                  >
                    <span>{EFFORT_LABELS[effort] ? text(...EFFORT_LABELS[effort]) : effort}</span>
                    {effort === draftEffort && <LinearIcon name="check" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {primaryAction === "stop" ? (
            <button
              className="ai-chat-send-button is-stop"
              type="button"
              aria-label={text("停止生成", "Stop generating")}
              title={text("停止", "Stop")}
              onClick={() => void stopRun(currentRun)}
            >
              <span className="ai-chat-stop-mark" aria-hidden="true" />
            </button>
          ) : (
            <button
              className="ai-chat-send-button"
              type="button"
              aria-label={text("发送消息", "Send message")}
              title={text("发送", "Send")}
              disabled={
                primaryAction === "disabled"
                || loading
                || settingsSaving
                || Boolean(catalogError)
              }
              onClick={() => void startMessage(draft, false)}
            >
              <LinearIcon name="send" />
            </button>
          )}
        </div>
      </div>

      {dangerConfirmOpen && (
        <div className="ai-chat-confirm-backdrop">
          <div className="ai-chat-confirm" role="alertdialog" aria-modal="true" aria-labelledby="ai-chat-confirm-title">
            <strong id="ai-chat-confirm-title">{text("允许完全访问？", "Allow full access?")}</strong>
            <p>{text(
              "本次消息允许 Codex 访问工作区之外的文件和命令。确认只对本次发送生效。",
              "This message lets Codex access files and commands outside the workspace. This approval applies only to this message.",
            )}</p>
            <div>
              <button type="button" onClick={() => setPendingDangerInput(null)}>
                {text("取消", "Cancel")}
              </button>
              <button
                className="is-danger"
                type="button"
                onClick={() => {
                  if (!pendingDangerInput) return;
                  void startMessage(
                    pendingDangerInput.message,
                    true,
                    pendingDangerInput.skillIds,
                    pendingDangerInput.clearSubmittedDraft,
                    pendingDangerInput.attachments,
                  );
                }}
              >
                {text("允许并发送", "Allow and send")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

