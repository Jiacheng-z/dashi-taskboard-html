import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { taskboardStorage } from "../storage";
import { useTaskboardI18n } from "../i18n";
import {
  deleteAiChatThread,
  getAiChatThread,
  listAiChatThreads,
  subscribeAiChatThread,
} from "../api";
import { buildThreadCreateInput, createAiSnapshotRefreshQueue } from "../aiChatState";
import type { AiChatRun, AiChatThread } from "../types";
import { LinearIcon } from "./LinearIcon";
import { TaskboardIcon } from "./TaskboardIcon";
import {
  AI_CHAT_UNAVAILABLE_ERROR,
  ConversationView,
  messageFor,
  type AiChatError,
} from "./ConversationView";

export type AiChatOpenThreadRequest = {
  threadId: string;
  requestId: number;
} | {
  projectId: string;
  issueId: string | null;
  composerText: string;
  requestId: number;
};

interface AiChatProps {
  available: boolean;
  projectId: string | null;
  issueId: string | null;
  onThreadsChange?: (threads: AiChatThread[]) => void;
  openThreadRequest?: AiChatOpenThreadRequest | null;
}

type DraftThreadOrigin = {
  projectId: string;
  issueId: string | null;
};
type PanelResizeEdge = "top" | "left" | "top-left";
type PanelGeometry = {
  width: number;
  height: number;
};
type PanelResizeSession = {
  edge: PanelResizeEdge;
  pointerId: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  geometry: PanelGeometry;
  captureTarget: HTMLElement;
};

const LAST_THREAD_KEY = "taskboard.aiChat.lastThreadId";
const PANEL_GEOMETRY_KEY = "taskboard.aiChat.panelGeometry";
const PANEL_EDGE_GAP = 8;
const PANEL_MIN_WIDTH = 420;
const PANEL_MAX_WIDTH = 960;
const PANEL_MIN_HEIGHT = 360;
const PANEL_DEFAULT_GEOMETRY: PanelGeometry = {
  width: 420,
  height: 700,
};
function clampPanelGeometry(geometry: PanelGeometry): PanelGeometry {
  const maxWidth = Math.min(
    PANEL_MAX_WIDTH,
    window.innerWidth - PANEL_EDGE_GAP * 2,
  );
  const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
  const maxHeight = window.innerHeight - PANEL_EDGE_GAP * 2;
  const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
  return {
    width: Math.min(maxWidth, Math.max(minWidth, geometry.width)),
    height: Math.min(maxHeight, Math.max(minHeight, geometry.height)),
  };
}

function loadPanelGeometry(): PanelGeometry {
  const stored = taskboardStorage.getItem(PANEL_GEOMETRY_KEY);
  if (!stored) return clampPanelGeometry(PANEL_DEFAULT_GEOMETRY);
  try {
    const geometry = JSON.parse(stored) as PanelGeometry;
    if (
      !Number.isFinite(geometry.width)
      || !Number.isFinite(geometry.height)
    ) {
      return clampPanelGeometry(PANEL_DEFAULT_GEOMETRY);
    }
    return clampPanelGeometry(geometry);
  } catch {
    return clampPanelGeometry(PANEL_DEFAULT_GEOMETRY);
  }
}

function dateLabel(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function AiChat({
  available,
  projectId,
  issueId,
  onThreadsChange,
  openThreadRequest,
}: AiChatProps) {
  const { locale, text } = useTaskboardI18n();
  const [panelOpen, setPanelOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [threads, setThreads] = useState<AiChatThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    () => taskboardStorage.getItem(LAST_THREAD_KEY),
  );
  const [draftOrigin, setDraftOrigin] = useState<DraftThreadOrigin | null>(null);
  const [error, setError] = useState<AiChatError | null>(null);
  const [requestedComposerText, setRequestedComposerText] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [panelGeometry, setPanelGeometry] = useState<PanelGeometry | null>(
    () => window.innerWidth <= 719 ? null : loadPanelGeometry(),
  );
  const [panelResizeEdge, setPanelResizeEdge] = useState<PanelResizeEdge | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const panelResizeSessionRef = useRef<PanelResizeSession | null>(null);
  const selectedThreadRef = useRef(selectedThreadId);
  const handledOpenThreadRequestRef = useRef<number | null>(null);
  const draftReturnThreadIdRef = useRef<string | null>(null);
  const panelOpenRef = useRef(panelOpen);
  const observedRunStatusesRef = useRef(new Map<string, AiChatRun["status"]>());

  const selectThread = useCallback((threadId: string | null) => {
    selectedThreadRef.current = threadId;
    setSelectedThreadId(threadId);
  }, []);

  useEffect(() => {
    selectedThreadRef.current = selectedThreadId;
    if (selectedThreadId) taskboardStorage.setItem(LAST_THREAD_KEY, selectedThreadId);
    else taskboardStorage.removeItem(LAST_THREAD_KEY);
  }, [selectedThreadId]);

  useEffect(() => {
    panelOpenRef.current = panelOpen;
    if (panelOpen) {
      setUnread(false);
      setPanelGeometry(window.innerWidth <= 719 ? null : loadPanelGeometry());
    }
  }, [panelOpen]);

  useEffect(() => {
    function finishPanelResize(pointerId?: number) {
      const session = panelResizeSessionRef.current;
      if (!session || (pointerId !== undefined && session.pointerId !== pointerId)) return;
      if (session.captureTarget.hasPointerCapture(session.pointerId)) {
        session.captureTarget.releasePointerCapture(session.pointerId);
      }
      if (window.innerWidth > 719) {
        taskboardStorage.setItem(
          PANEL_GEOMETRY_KEY,
          JSON.stringify(session.geometry),
        );
      }
      panelResizeSessionRef.current = null;
      setPanelResizeEdge(null);
    }

    function resizePanel(event: PointerEvent) {
      const session = panelResizeSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      event.preventDefault();

      const maxWidth = Math.min(
        PANEL_MAX_WIDTH,
        window.innerWidth - PANEL_EDGE_GAP * 2,
      );
      const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
      const maxHeight = window.innerHeight - PANEL_EDGE_GAP * 2;
      const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
      const resizeWidth = session.edge === "left" || session.edge === "top-left";
      const resizeHeight = session.edge === "top" || session.edge === "top-left";
      const width = resizeWidth
        ? Math.min(
            maxWidth,
            Math.max(minWidth, session.startWidth - (event.clientX - session.startX)),
          )
        : session.startWidth;
      const height = resizeHeight
        ? Math.min(
            maxHeight,
            Math.max(minHeight, session.startHeight - (event.clientY - session.startY)),
          )
        : session.startHeight;
      session.geometry = { width, height };
      setPanelGeometry(session.geometry);
    }

    function handlePointerEnd(event: PointerEvent) {
      finishPanelResize(event.pointerId);
    }

    function handleWindowBlur() {
      finishPanelResize();
    }

    function handleWindowResize() {
      finishPanelResize();
      if (window.innerWidth <= 719) {
        setPanelGeometry(null);
        return;
      }

      setPanelGeometry(loadPanelGeometry());
    }

    window.addEventListener("pointermove", resizePanel, { passive: false });
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("pointermove", resizePanel);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("resize", handleWindowResize);
    };
  }, []);

  function startPanelResize(
    event: ReactPointerEvent<HTMLDivElement>,
    edge: PanelResizeEdge,
  ) {
    if (window.innerWidth <= 719) return;
    const panel = panelRef.current;
    if (!panel) return;

    event.preventDefault();
    event.stopPropagation();
    const rect = panel.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    panelResizeSessionRef.current = {
      edge,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
      geometry: {
        width: rect.width,
        height: rect.height,
      },
      captureTarget: event.currentTarget,
    };
    setPanelGeometry({
      width: rect.width,
      height: rect.height,
    });
    setPanelResizeEdge(edge);
  }

  const replaceThread = useCallback((thread: AiChatThread) => {
    setThreads((current) => {
      const next = current.filter((candidate) => candidate.id !== thread.id);
      return [thread, ...next].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
  }, []);

  const observeRunTransitions = useCallback((runs: AiChatRun[]) => {
    let completedWhileClosed = false;
    for (const run of runs) {
      const previous = observedRunStatusesRef.current.get(run.id);
      observedRunStatusesRef.current.set(run.id, run.status);
      if (
        previous === "running"
        && run.status !== "running"
        && !panelOpenRef.current
      ) completedWhileClosed = true;
    }
    if (completedWhileClosed) setUnread(true);
  }, []);

  const loadThreads = useCallback(async () => {
    try {
      const next = await listAiChatThreads();
      setThreads(next);
      setSelectedThreadId((current) => {
        const selected = current && next.some((thread) => thread.id === current)
          ? current
          : next[0]?.id ?? null;
        selectedThreadRef.current = selected;
        return selected;
      });
    } catch (nextError) {
      setError(messageFor(nextError));
    }
  }, []);

  useEffect(() => {
    if (!available) {
      setPanelOpen(false);
      setThreads([]);
      return;
    }
    void loadThreads();
  }, [available, loadThreads]);

  useEffect(() => {
    onThreadsChange?.(available ? threads : []);
  }, [available, onThreadsChange, threads]);

  const backgroundRunningThreadIds = threads
    .filter((thread) => thread.status === "running" && thread.id !== selectedThreadId)
    .map((thread) => thread.id);
  useEffect(() => {
    if (!available || backgroundRunningThreadIds.length === 0) return;
    const refresh = async (threadId: string) => {
      try {
        const next = await getAiChatThread(threadId);
        replaceThread(next.thread);
        observeRunTransitions(next.runs);
      } catch {
        // The selected thread surfaces request errors; background history refresh stays quiet.
      }
    };
    const refreshQueue = createAiSnapshotRefreshQueue(refresh);
    const unsubscribers = backgroundRunningThreadIds.map((threadId) => (
      subscribeAiChatThread(threadId, () => void refreshQueue.request(threadId))
    ));
    return () => {
      refreshQueue.clear();
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [
    available,
    backgroundRunningThreadIds.join(","),
    observeRunTransitions,
    replaceThread,
    selectedThreadId,
  ]);

  const anyRunning = threads.some((thread) => thread.status === "running");
  const anyFailed = threads.some((thread) => thread.status === "failed");
  const launcherState = anyRunning ? "running" : anyFailed ? "failed" : unread ? "unread" : "idle";

  useEffect(() => {
    if (!available || !openThreadRequest) return;
    if (handledOpenThreadRequestRef.current === openThreadRequest.requestId) return;
    if ("composerText" in openThreadRequest) {
      handledOpenThreadRequestRef.current = openThreadRequest.requestId;
      if (!draftOrigin) draftReturnThreadIdRef.current = selectedThreadRef.current;
      setDraftOrigin({
        projectId: openThreadRequest.projectId,
        issueId: openThreadRequest.issueId,
      });
      selectThread(null);
      setHistoryOpen(false);
      setError(null);
      setRequestedComposerText(openThreadRequest.composerText);
      setPanelOpen(true);
      return;
    }
    if (!threads.some((thread) => thread.id === openThreadRequest.threadId)) return;
    handledOpenThreadRequestRef.current = openThreadRequest.requestId;
    draftReturnThreadIdRef.current = null;
    setDraftOrigin(null);
    selectThread(openThreadRequest.threadId);
    setHistoryOpen(false);
    setError(null);
    setPanelOpen(true);
  }, [
    available,
    draftOrigin,
    openThreadRequest,
    selectThread,
    threads,
  ]);

  function restorePersistedConversationFromDraft() {
    if (!draftOrigin) return;
    const previousThreadId = draftReturnThreadIdRef.current;
    const nextThreadId = previousThreadId && threads.some((thread) => thread.id === previousThreadId)
      ? previousThreadId
      : threads[0]?.id ?? null;
    draftReturnThreadIdRef.current = null;
    setDraftOrigin(null);
    selectThread(nextThreadId);
  }


  useEffect(() => {
    if (
      !draftOrigin
      || (
        draftOrigin.projectId === projectId
        && draftOrigin.issueId === (issueId ?? null)
      )
    ) return;
    restorePersistedConversationFromDraft();
  }, [draftOrigin?.issueId, draftOrigin?.projectId, issueId, projectId]);

  function beginNewConversation() {
    const input = buildThreadCreateInput(projectId ?? "", issueId);
    if (!input) {
      setError(text(
        "请先进入一个已映射的项目，再新建对话",
        "Open a mapped project before you start a new chat.",
      ));
      return;
    }
    if (!draftOrigin) draftReturnThreadIdRef.current = selectedThreadRef.current;
    setDraftOrigin({
      projectId: input.projectId,
      issueId: input.issueId ?? null,
    });
    selectThread(null);
    setHistoryOpen(false);
    setError(null);
  }

  async function deleteThread(thread: AiChatThread) {
    if (!window.confirm(text(
      `删除本地对话“${thread.title}”？`,
      `Delete local chat “${thread.title}”?`,
    ))) return;
    setDeletingThreadId(thread.id);
    try {
      await deleteAiChatThread(thread.id);
      const remainingThreads = threads.filter((candidate) => candidate.id !== thread.id);
      setThreads(remainingThreads);
      if (selectedThreadRef.current === thread.id) {
        setDraftOrigin(null);
        selectThread(remainingThreads[0]?.id ?? null);
      }
      setError(null);
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setDeletingThreadId(null);
    }
  }

  if (!available) return null;

  return (
    <div className={`ai-chat-root is-${launcherState}`}>
      {panelOpen && (
        <section
          ref={panelRef}
          className={`ai-chat-panel${panelResizeEdge ? ` is-resizing-${panelResizeEdge}` : ""}`}
          style={panelGeometry ?? undefined}
          aria-label={text("Codex AI 对话", "Codex AI chat")}
          data-screen-label={text("Codex AI 对话", "Codex AI chat")}
        >
          <div
            className="ai-chat-resize-handle is-top"
            aria-hidden="true"
            onPointerDown={(event) => startPanelResize(event, "top")}
          />
          <div
            className="ai-chat-resize-handle is-left"
            aria-hidden="true"
            onPointerDown={(event) => startPanelResize(event, "left")}
          />
          <div
            className="ai-chat-resize-handle is-top-left"
            aria-hidden="true"
            onPointerDown={(event) => startPanelResize(event, "top-left")}
          />
          <header className="ai-chat-panel-header">
            <div className="ai-chat-panel-title">
              <strong>{threads.find((thread) => thread.id === selectedThreadId)?.title ?? text("新对话", "New chat")}</strong>
              <span>{text(
                "选择对话或从当前项目新建",
                "Select a chat or start one in the current project",
              )}</span>
            </div>
            <button
              type="button"
              aria-label={text("对话历史", "Chat history")}
              aria-pressed={historyOpen}
              title={text("对话历史", "Chat history")}
              onClick={() => setHistoryOpen((current) => !current)}
            >
              <LinearIcon name="conversation" />
            </button>
            <button
              type="button"
              aria-label={text("新建对话", "New chat")}
              title={projectId
                ? text("新建对话", "New chat")
                : text("请先进入项目", "Open a project first")}
              disabled={!projectId}
              onClick={beginNewConversation}
            >
              <LinearIcon name="plus" />
            </button>
            <button
              type="button"
              aria-label={text("关闭 AI 对话", "Close AI chat")}
              title={text("关闭", "Close")}
              onClick={() => {
                restorePersistedConversationFromDraft();
                setPanelOpen(false);
              }}
            >
              <LinearIcon name="close" />
            </button>
          </header>

          {historyOpen && (
            <div className="ai-chat-history" aria-label={text("对话历史", "Chat history")}>
              <div className="ai-chat-history-heading">
                <strong>{text("对话历史", "Chat history")}</strong>
                <span>{threads.length}</span>
              </div>
              {threads.length > 0 ? threads.map((thread) => (
                <div
                  className={`ai-chat-history-row${thread.id === selectedThreadId ? " is-active" : ""}`}
                  key={thread.id}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (thread.id !== selectedThreadRef.current) setRequestedComposerText(null);
                      draftReturnThreadIdRef.current = null;
                      setDraftOrigin(null);
                      selectThread(thread.id);
                      setHistoryOpen(false);
                    }}
                  >
                    <span className={`ai-chat-thread-status is-${thread.status}`} aria-hidden="true" />
                    <span>
                      <strong>{thread.title}</strong>
                      <small>{thread.origin.projectName} · {dateLabel(thread.updatedAt, locale)}</small>
                    </span>
                  </button>
                  <button
                    className="ai-chat-history-delete"
                    type="button"
                    aria-label={text(`删除对话 ${thread.title}`, `Delete chat ${thread.title}`)}
                    title={text("删除本地记录", "Delete local record")}
                    disabled={thread.status === "running" || deletingThreadId === thread.id}
                    onClick={() => void deleteThread(thread)}
                  >
                    <LinearIcon name="trash" />
                  </button>
                </div>
              )) : (
                <p>{text("还没有本地对话", "No local chats yet")}</p>
              )}
            </div>
          )}

          <ConversationView
            available={available}
            projectId={projectId}
            issueId={issueId}
            threadId={selectedThreadId}
            deleting={deletingThreadId !== null && deletingThreadId === selectedThreadId}
            error={error}
            initialComposerText={requestedComposerText}
            onError={setError}
            onThreadCreated={selectThread}
            onThreadUpdate={replaceThread}
            onRunsObserved={observeRunTransitions}
            onRequestClose={() => {
              if (historyOpen) {
                setHistoryOpen(false);
                return;
              }
              restorePersistedConversationFromDraft();
              setPanelOpen(false);
            }}
          />
        </section>
      )}

      {!panelOpen && (
        <button
          type="button"
          className={`ai-chat-launcher is-${launcherState}`}
          aria-label={text("打开 AI 对话", "Open AI chat")}
          aria-expanded="false"
          title={text("AI 对话", "AI chat")}
          onClick={() => setPanelOpen(true)}
        >
          <TaskboardIcon name="aiLauncher" />
          {launcherState !== "idle" && <span className="ai-chat-launcher-state" aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}
