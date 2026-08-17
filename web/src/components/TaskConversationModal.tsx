import { useCallback, useState } from "react";

import { useTaskboardI18n } from "../i18n";
import { ConversationView, type AiChatError } from "./ConversationView";

// 必须是模块级稳定引用：ConversationView 的 loadSnapshot（useCallback）把 onRunsObserved
// 列进依赖，这里若每次渲染传新的内联箭头函数，会同 onThreadUpdate 一样引发无限重跑
// （见下方 handleThreadsChange 的注释），这条任务对话弹窗本就不关心 run 未读判定。
function noopRunsObserved() {}

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
  // 必须稳定：ConversationView 的 loadSnapshot（useCallback）把 onThreadUpdate 列进依赖，
  // 这里若每次渲染传新的内联箭头函数，loadSnapshot 引用跟着变 → 依赖它的「按 threadId 加载」
  // effect 被判定为需要重跑 → 重置 snapshot 并再次进入「正在恢复对话」loading 态 → 加载完再次
  // 调用 onThreadUpdate 触发外壳重渲染 → 循环，即用户报告的「正在恢复对话」无限闪烁。
  const handleThreadsChange = useCallback(() => {
    onThreadsChange?.();
  }, [onThreadsChange]);

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
            onThreadCreated={handleThreadsChange}
            onThreadUpdate={handleThreadsChange}
            onRunsObserved={noopRunsObserved}
            onRequestClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
