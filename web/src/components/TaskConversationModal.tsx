import { useState } from "react";

import { useTaskboardI18n } from "../i18n";
import { ConversationView, type AiChatError } from "./ConversationView";

export interface TaskConversationModalProps {
  open: boolean;
  /** 已绑定的会话 id；为 null 时显示「任务尚无会话」空态 */
  threadId: string | null;
  projectId: string | null;
  issueId: string | null;
  onClose: () => void;
  onThreadsChange?: () => void;
}

export function TaskConversationModal({
  open,
  threadId,
  projectId,
  issueId,
  onClose,
  onThreadsChange,
}: TaskConversationModalProps) {
  const { text } = useTaskboardI18n();
  const [error, setError] = useState<AiChatError | null>(null);

  if (!open) return null;

  return (
    <div
      className="task-conversation-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="task-conversation-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={text("任务对话", "Task conversation")}
      >
        <header className="task-conversation-header">
          <span className="task-conversation-title">
            {text("任务对话", "Task conversation")}
          </span>
          <button
            type="button"
            className="task-conversation-close"
            onClick={onClose}
            aria-label={text("关闭", "Close")}
          >
            ×
          </button>
        </header>
        {threadId === null ? (
          <p className="task-conversation-empty">
            {text("任务尚无会话", "This task has no conversation yet")}
          </p>
        ) : (
          <ConversationView
            available
            projectId={projectId}
            issueId={issueId}
            threadId={threadId}
            deleting={false}
            error={error}
            readOnlyWhileRunning
            onError={setError}
            onThreadCreated={() => onThreadsChange?.()}
            onThreadUpdate={() => onThreadsChange?.()}
            onRunsObserved={() => {}}
            onRequestClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
