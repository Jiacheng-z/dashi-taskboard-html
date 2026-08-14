// 历史上这个文件是 2741 行的「面板 + 对话视图」合体。
// 拆分后实体在 QuickChatPanel / ConversationView / AiChatMessages / TaskConversationModal，
// 这里只保留门面，避免调用方改 import 路径。
export { QuickChatPanel as AiChat } from "./QuickChatPanel";
export type { AiChatOpenThreadRequest } from "./QuickChatPanel";
export type { QuickChatPanelProps as AiChatProps } from "./QuickChatPanel";
