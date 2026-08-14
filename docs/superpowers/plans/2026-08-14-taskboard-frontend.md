# 任务对话弹窗与自动化配置前端化 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 `AiChat.tsx` 拆成「对话视图 + 两种外壳」，新增居中的任务对话弹窗，并把自动化配置从 codex app 的 host message 链路换成真正的 HTTP 接口。

**架构：** `AiChat.tsx`（2741 行）按已有的内部组件边界切成 5 个文件：纯展示组件进 `AiChatMessages.tsx`，时间线 + 输入框 + SSE 订阅进 `ConversationView.tsx`，右下角面板外壳留在 `QuickChatPanel.tsx`，新增 `TaskConversationModal.tsx` 复用同一个 `ConversationView`。自动化配置侧删掉 `App.tsx` 里整套 host message 状态机，改调 A2 任务 11 已经做好的 `GET/PATCH /api/projects/:id/automation`，模型/思考强度列表改从 `getAiChatCatalog` 取。

**技术栈：** React 19 + TypeScript + Vite；测试是 `node --test`，前端测试的形式是「读源码文本 + 断言字符串」，没有 jsdom。

---

## 前置条件

1. **A1 已完成**（13 个 commit `3312a92`…`24192a2`，均在 `main`）。后端可插拔基建、`settings` 表、`ai_chat_threads.backend` 列、`GET/PATCH /api/local/ai/backend` 都已就位。
2. **A2 必须先完成**。本计划的任务 8 直接调用 A2 任务 11 新增的 `GET/PATCH /api/projects/:id/automation`；任务 6 依赖 A2 任务 13（`in_review` 追问自动拉回 `in_progress`）才有完整语义。
3. A2 已经改过 `web/src/api.ts`（任务 13/16）、`web/src/App.tsx`（任务 14）、`web/src/taskConversations.ts`（任务 16）。**开工前先 `git log --oneline -20` 确认这些 commit 在位**，再读一遍这三个文件的当前内容，不要照抄本计划里的行号——行号是 A2 之前的快照。

## 回归命令

**必须用范围收窄版**，`npm test` 有 24 个既有环境红灯（cloud 那批要 D1/wrangler/miniflare；chromium 驱动的那批缺 dbus/UPower 直接 SIGSEGV），不要试图修：

```bash
cd /home/work/vdc/dashi-taskboard
node --test $(ls test/*.test.mjs | grep -vE "cloud-|inject|task-editor")
npx tsc --noEmit -p web/tsconfig.json
```

Node 默认 reporter 打的是 `ℹ tests N` / `ℹ pass N` / `ℹ fail N`（不是 `# pass`），grep 要用 `ℹ`。A1 完成时的基线是 **337/337/0**；A2 会把这个数字抬高，以 A2 收尾时记录的数字为本计划的起点基线。

## commit 约定

仓库**没配 `user.name` / `user.email`**，每次提交都要显式带上，不要改 global config：

```bash
git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" commit -m "..."
```

**只 `git add` 本任务明确改到的文件，绝不 `git add -A`。** 仓库里有三处既有脏东西，任何时候都不要 stage：

| 脏东西 | 说明 |
|---|---|
| 已修改的 `package.json` | diff 里混着 `taskboard:automation` 脚本行和使用者自己的 `allowScripts` 块 |
| 未跟踪的 `package.json.orig` | 使用者的备份 |
| 未跟踪的 `scripts/taskboard-automation-local.mjs` | codex 生成的旧脚本，A2 任务 12 会重写它 |

## 与规格的偏离

规格是 `docs/superpowers/specs/2026-08-13-taskboard-local-agent-design.md`。实施时确认了三处与规格描述不符的事实，本计划按事实走：

| # | 规格怎么说 | 实际是什么 | 本计划怎么做 |
|---|---|---|---|
| 1 | §7.2 拆成 3 个文件（`ConversationView` / `QuickChatPanel` / `TaskConversationModal`） | 规格列出的 7 个内部展示组件（`SkillReference` 等）如果留在 `ConversationView` 里，那个文件会有 1400+ 行 | 拆成 **5 个**文件，多一个 `AiChatMessages.tsx` 装纯展示组件；`AiChat.tsx` 保留为 re-export 门面 |
| 2 | §7.4「`in_progress`（有 running run）→ 输入框禁用，只读」 | **现状根本没有这个禁用**。`AiChat.tsx:1412` 的 `composerBlocked` 只覆盖「正在删除这个 thread」；跑动中只是发不出去（`primaryAction === "stop"`），打字是允许的 | 不改共享默认行为，给 `ConversationView` 加**可选** prop `readOnlyWhileRunning`，只有弹窗传 `true`。否则右下角快捷对话的既有手感会回退 |
| 3 | §8.3「`ProjectAutomationMenu` props 不变」 | 删掉 `quotaAware` 后 `automation` / `onChange` 的负载形状必然变；模型列表要从 catalog 来，就得多一个入口 | props 从 6 个变 7 个（多一个 `models`），其余 6 个名字与语义不变。菜单仍是纯展示组件——**不在它内部 fetch**，catalog 由 `App.tsx` 拉好传进来 |

另有一处规格没提但必须做的：`shared/taskboard-automation-options.mjs`（69 行）**不能删**。`shared/taskboard-automation.mjs`(222 行) 引它，`scripts/codex-injector.mjs:17` 又引后者，而规格 §10.3 明确要求保留整条 injector 链路可回退。本计划只删**前端**的两处 import（`ProjectAutomationMenu.tsx`、`App.tsx`），文件本体和它的两个测试（`test/taskboard-automation.test.mjs` 503 行、`test/inject.test.mjs:6`）原样不动。

## 文件结构

### 新建

| 文件 | 职责 |
|---|---|
| `web/src/components/AiChatMessages.tsx` | 纯展示：`SkillReference`、`MarkdownMessage`、`ThinkingStepDetail`、`ThinkingSteps`、`EventAttachments`、`MessageTimeline`、`OptionMenu` + 它们各自依赖的模块级辅助函数。无状态、无 SSE、无 fetch |
| `web/src/components/ConversationView.tsx` | 一条会话的全部：threads/snapshot 加载、SSE 订阅、catalog、草稿设置、输入框与 skill 提及、附件、发送与中断。**不含任何定位/外壳/尺寸** |
| `web/src/components/QuickChatPanel.tsx` | 右下角面板外壳：launcher 按钮、几何尺寸与拖拽、历史列表抽屉、`LAST_THREAD_KEY` 记忆。内部放一个 `ConversationView` |
| `web/src/components/TaskConversationModal.tsx` | 居中 1100px × 85vh + 遮罩。内部放同一个 `ConversationView`，并给它传 `readOnlyWhileRunning` |

### 修改

| 文件 | 改什么 |
|---|---|
| `web/src/components/AiChat.tsx` | 从 2741 行缩成十几行的门面：`export { QuickChatPanel as AiChat }` + 类型 re-export，保持既有 import 路径不断 |
| `web/src/components/ProjectAutomationMenu.tsx` | 删 `quotaAware` 开关与额度提示块；模型/强度列表改用 props 传入的 catalog |
| `web/src/App.tsx` | 删整套 host message 自动化状态机；`openTaskConversation` 改为打开弹窗；挂载 `TaskConversationModal`；自动化配置改走 fetch |
| `web/src/api.ts` | 新增 `getProjectAutomation` / `updateProjectAutomation` |
| `web/src/i18n.tsx` | `blocked` 的中文标签 `遇到阻碍` → `等你回答` |
| `web/src/components/BoardColumn.tsx` | `STATUS_DETAILS.blocked.label` 同步改 |
| `web/src/styles.css` | 新增 `.task-conversation-*` 一组类 |
| `test/ai-chat-ui.test.mjs` | `chatSource` 改为 5 个文件的拼接；1 处断言改名 |
| `test/project-automation-settings.test.mjs` | 重写掉 host message 契约相关的断言 |
| `test/other-tasks-panel.test.mjs`、`test/board-interactions.test.mjs` | 各 1 处 `遇到阻碍` 字面量断言 |

## 任务 1：把 `chatSource` 改成 5 个文件的拼接

规格 §9.4 要求这件事**单列一个任务**：`test/ai-chat-ui.test.mjs` 里 `chatSource` 被引用 46 次，拆文件会让它们成片失败。先把读取口改成「AI 对话组件族的全部源码」，后续任务搬代码时断言自然跟着走。

**文件：**
- 修改：`test/ai-chat-ui.test.mjs:19-25`

- [ ] **步骤 1：先记录当前基线**

运行：`cd /home/work/vdc/dashi-taskboard && node --test test/ai-chat-ui.test.mjs 2>&1 | grep 'ℹ'`

预期：`ℹ fail 0`。把 `ℹ tests` 的数字记下来，后面每一步都要求它不变。

- [ ] **步骤 2：替换 `chatSource` 的定义**

把 `test/ai-chat-ui.test.mjs:20-23` 这三行：

```js
const chatSource = await readFile(
  new URL("../web/src/components/AiChat.tsx", import.meta.url),
  "utf8",
);
```

换成：

```js
const AI_CHAT_SOURCE_FILES = [
  "../web/src/components/AiChat.tsx",
  "../web/src/components/AiChatMessages.tsx",
  "../web/src/components/ConversationView.tsx",
  "../web/src/components/QuickChatPanel.tsx",
  "../web/src/components/TaskConversationModal.tsx",
];

// 拆分期间这些文件是逐个出现的，缺文件按空串处理；
// 断言的语义是「这段代码在 AI 对话组件族里存在」，不绑定具体落在哪个文件。
async function readAiChatSource() {
  const parts = await Promise.all(AI_CHAT_SOURCE_FILES.map(async (relative) => {
    try {
      return await readFile(new URL(relative, import.meta.url), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  }));
  return parts.join("\n");
}

const chatSource = await readAiChatSource();
```

- [ ] **步骤 3：证明容错读取真的在拼接，不是静默吞掉一切**

运行：

```bash
cd /home/work/vdc/dashi-taskboard && node -e '
const { access } = require("node:fs/promises");
const files = ["AiChat","AiChatMessages","ConversationView","QuickChatPanel","TaskConversationModal"];
Promise.all(files.map(async (name) => {
  const path = `web/src/components/${name}.tsx`;
  try { await access(path); return `${name}: found`; }
  catch { return `${name}: missing`; }
})).then((lines) => console.log(lines.join("\n")));
'
```

预期输出恰好是（拆分还没开始，只有第一个存在）：

```
AiChat: found
AiChatMessages: missing
ConversationView: missing
QuickChatPanel: missing
TaskConversationModal: missing
```

如果 5 个全 missing，说明相对路径写错了（`import.meta.url` 是 `test/` 下，要 `../web/...`）。

- [ ] **步骤 4：跑测试确认数量与结果都没变**

运行：`cd /home/work/vdc/dashi-taskboard && node --test test/ai-chat-ui.test.mjs 2>&1 | grep 'ℹ'`

预期：`ℹ tests` 与步骤 1 完全相同，`ℹ fail 0`。

- [ ] **步骤 5：Commit**

```bash
cd /home/work/vdc/dashi-taskboard
git add test/ai-chat-ui.test.mjs
git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
  commit -m "test: chatSource 覆盖整个 AI 对话组件族（任务 1/10）"
```

## 任务 2：抽出 `AiChatMessages.tsx`（7 个纯展示组件）

规格 §7.2 点名了 7 个天然边界。它们全是纯展示，没有 fetch、没有 SSE、没有 `useEffect` 订阅，先搬这一层，`ConversationView` 的抽取才不至于变成 1400 行。

**文件：**
- 创建：`web/src/components/AiChatMessages.tsx`
- 修改：`web/src/components/AiChat.tsx`（删掉搬走的块，改为 import）
- 测试：`test/ai-chat-ui.test.mjs`

搬走的定义（行号是拆分前的快照，实施时以名字为准）：

| 名字 | 行 |
|---|---|
| `SkillReference` | 547 |
| `MarkdownMessage` | 684 |
| `ThinkingStepDetail` | 711 |
| `ThinkingSteps` | 750 |
| `EventAttachments` | 858 |
| `MessageTimeline` | 888 |
| `OptionMenu` | 968 |

连带搬走的模块级辅助（判定规则见步骤 3）：`skillDisplayName`221、`eventSkillIds`237、`eventHasAttachments`243、`decodedSkillPath`380、`skillMarkdown`530、`dateLabel`612、`type ThinkingActivityDetail`623、`parsedTodoLines`627、`activityDetail`642、`activityDetailSummary`672。

- [ ] **步骤 1：先写失败的测试**

在 `test/ai-chat-ui.test.mjs` 末尾追加：

```js
test("展示层组件独立成 AiChatMessages.tsx", async () => {
  const messagesSource = await readFile(
    new URL("../web/src/components/AiChatMessages.tsx", import.meta.url),
    "utf8",
  );
  for (const name of [
    "SkillReference",
    "MarkdownMessage",
    "ThinkingStepDetail",
    "ThinkingSteps",
    "EventAttachments",
    "MessageTimeline",
    "OptionMenu",
  ]) {
    assert.match(messagesSource, new RegExp(`export function ${name}\\(`));
  }
  assert.doesNotMatch(messagesSource, /useEffect|EventSource|fetch\(/);
});
```

- [ ] **步骤 2：跑测试验证失败**

运行：`cd /home/work/vdc/dashi-taskboard && node --test test/ai-chat-ui.test.mjs 2>&1 | grep -E 'ℹ|ENOENT'`

预期：FAIL，报 `ENOENT ... AiChatMessages.tsx`。

- [ ] **步骤 3：判定每个辅助函数归谁**

对上表列的每个辅助逐个执行（把 `NAME` 换成函数名）：

```bash
cd /home/work/vdc/dashi-taskboard && grep -n '\bNAME\b' web/src/components/AiChat.tsx
```

判定规则，没有例外：

- 全部引用都落在「7 个组件的函数体」区间内 → **搬进 `AiChatMessages.tsx`，不导出**
- 既被 7 个组件用、又被 `AiChat`(982) 或输入框相关函数用 → **搬进 `AiChatMessages.tsx` 并 `export`**，`AiChat.tsx` 从新文件 import 回来
- 只被 7 个组件之外的代码用 → **不搬**

已知会跨界的至少有 `eventHasAttachments`（`AiChat` 里 `retryableUserEvent` 用它，见 `AiChat.tsx:1437`）和 `skillMarkdown`（输入框插入 skill 时用）。判定完把结果写进 commit message，后续任务要照着它决定 import。

- [ ] **步骤 4：建 `AiChatMessages.tsx`**

新文件顶部只写实际用到的 import（`react`、`../types`、`../api`、`./AiChatIcons` 之类，以搬走的代码实际引用为准；`npx tsc` 会指出漏的），然后把 7 个组件与判定为「搬」的辅助**原样粘贴**，7 个组件前加 `export`。

不要顺手改任何一行实现——这一步是纯搬迁，改动混进来会让后面 44 条 `chatSource` 断言的失败无法归因。

- [ ] **步骤 5：清理 `AiChat.tsx`**

删掉搬走的块，在文件头加：

```tsx
import {
  EventAttachments,
  MarkdownMessage,
  MessageTimeline,
  OptionMenu,
  SkillReference,
  ThinkingStepDetail,
  ThinkingSteps,
} from "./AiChatMessages";
```

再按步骤 3 的判定补上跨界辅助的 import。如果某个组件在 `AiChat.tsx` 里已经没有任何引用（例如 `ThinkingStepDetail` 只被 `ThinkingSteps` 用），**不要 import 它**，否则 `tsc` 报未使用。

- [ ] **步骤 6：跑类型检查与测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard
npx tsc --noEmit -p web/tsconfig.json
node --test test/ai-chat-ui.test.mjs 2>&1 | grep 'ℹ'
```

预期：`tsc` 无输出；`ℹ fail 0`，`ℹ tests` 比任务 1 多 1。

44 条既有 `chatSource` 断言之所以照旧通过，是因为任务 1 已经把它改成了拼接。如果有断言失败，先确认失败的字符串现在落在哪个文件里：`grep -rn '失败的字符串' web/src/components/`。

- [ ] **步骤 7：跑全量回归**

运行：`cd /home/work/vdc/dashi-taskboard && node --test $(ls test/*.test.mjs | grep -vE "cloud-|inject|task-editor") 2>&1 | grep 'ℹ'`

预期：`ℹ fail 0`。

- [ ] **步骤 8：Commit**

```bash
cd /home/work/vdc/dashi-taskboard
git add web/src/components/AiChatMessages.tsx web/src/components/AiChat.tsx test/ai-chat-ui.test.mjs
git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
  commit -m "refactor: 展示层组件抽到 AiChatMessages.tsx（任务 2/10）"
```

## 任务 3：抽出 `ConversationView.tsx`

这是整个拆分里唯一需要动脑的一步：把「一条会话」的状态从「面板外壳」的状态里分出来。

**文件：**
- 创建：`web/src/components/ConversationView.tsx`
- 修改：`web/src/components/AiChat.tsx`
- 测试：`test/ai-chat-ui.test.mjs`

### 状态归属

| 留在外壳（任务 4 的 `QuickChatPanel`） | 进 `ConversationView` |
|---|---|
| `panelOpen`、几何尺寸与拖拽（`clampPanelGeometry`156、`loadPanelGeometry`170、resize 效果 1059-1136、`startPanelResize`1138） | `snapshot`、SSE 订阅（1250-1273）、`loadSnapshot`1191 |
| `threads` 列表与历史抽屉（`loadThreads`1221、`historyOpen`） | `catalog` / `activeCatalog`（1306-1339）、草稿设置（`restoreDraftSettings`1341、1347） |
| `selectedThreadId`、`LAST_THREAD_KEY` 记忆（120、1045）、`selectThread`1040 | 输入框全套（`syncComposerState`1713 一直到 `handleComposerKeyDown`2117-2151） |
| `unread` / `launcherState` / `backgroundRunningThreadIds`（1275-1303） | 附件（1458、`addAttachments`1936、拖放 1987-2006） |
| `deletingThreadId` 与 `deleteThread`1642 | 发送与中断（`startMessage`1862-1930、`stopRun`2105） |
| `openThreadRequest` 效果 1476-1522（决定"打开哪条"） | `saveThreadSettings`1666、`chooseModel`1690/`chooseEffort`1701/`chooseSandbox`1707 |

### 契约

`ConversationView` 是**受控**组件：thread 的选择权在外壳，它只负责渲染并回报。

```tsx
export type AiChatError = string | typeof AI_CHAT_UNAVAILABLE_ERROR;

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
```

`AI_CHAT_UNAVAILABLE_ERROR`、`AiChatError`、`messageFor`(602) 一起搬进 `ConversationView.tsx` 并 `export`，外壳 import 回去用。

### 三个必须守住的细节

1. **`threadId` 不能当 key。** 草稿态发送时 `startMessage` 内部会先建 thread 再发第一轮；如果 `<ConversationView key={threadId}>`，`onThreadCreated` 触发的重渲染会卸载组件，`startMessage` 后半段拿到已卸载的 ref。用 prop + 效果，不用 key。
2. **ESC 用捕获阶段的 `document` 监听器。** 现有 ESC 效果在 1372-1390。React 的子组件效果先于父组件效果执行，所以 `ConversationView` 注册得更早、先收到事件。它必须按 `dangerConfirmOpen` → `skillMention` → `menu` 的顺序自己消化，都没有才调 `onRequestClose()`。顺序错了会出现「按一次 ESC 直接关掉整个弹窗、危险确认框都没关」。
3. **`selectedThreadId` 在 `ConversationView` 里统一改名 `threadId`，但 `selectedThreadRef` 保持原名。** `test/ai-chat-ui.test.mjs:209` 钉了 `selectedThreadRef.current === threadId` 这个字符串，改名会踩它。

- [ ] **步骤 1：先写失败的测试**

在 `test/ai-chat-ui.test.mjs` 末尾追加：

```js
test("ConversationView 是受控的纯对话视图，不含面板外壳", async () => {
  const viewSource = await readFile(
    new URL("../web/src/components/ConversationView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(viewSource, /export interface ConversationViewProps/);
  for (const prop of [
    "threadId",
    "onThreadCreated",
    "onThreadUpdate",
    "onRunsObserved",
    "onRequestClose",
    "readOnlyWhileRunning",
  ]) {
    assert.match(viewSource, new RegExp(`\\b${prop}\\b`));
  }
  // 外壳的东西一律不许出现在视图里
  assert.doesNotMatch(viewSource, /panelGeometry|PanelResizeEdge|LAST_THREAD_KEY|historyOpen/);
  // ESC 必须走捕获阶段，且比 onRequestClose 先处理内部弹层
  assert.match(viewSource, /addEventListener\("keydown", [^,]+, true\)/);
  const danger = viewSource.indexOf("dangerConfirmOpen");
  const close = viewSource.indexOf("onRequestClose()");
  assert.ok(danger > 0 && close > 0 && danger < close);
});
```

- [ ] **步骤 2：跑测试验证失败**

运行：`cd /home/work/vdc/dashi-taskboard && node --test test/ai-chat-ui.test.mjs 2>&1 | grep -E 'ℹ|ENOENT'`

预期：FAIL，报 `ENOENT ... ConversationView.tsx`。

- [ ] **步骤 3：建 `ConversationView.tsx`，搬状态与逻辑**

按上面的「状态归属」表，把右列的 `useState` / `useRef` / `useCallback` / `useEffect` / 派生量从 `AiChat.tsx` 剪进新文件。`AiChat.tsx:1404-1439` 那段派生量整体属于视图：

```tsx
  const selectedModel = activeCatalog?.models.find((model) => model.slug === draftModel) ?? null;
  const availableSandboxes = (activeCatalog?.sandboxes ?? []).filter(isAiChatSandbox);
  const currentRun = snapshot?.thread.currentRun
    ?? snapshot?.runs.find((run) => run.status === "running")
    ?? null;
```

`composerBlocked` 这一行照搬（任务 6 才改它）：

```tsx
  const composerBlocked = Boolean(threadId && deleting);
```

原来是 `Boolean(selectedThreadId && deletingThreadId === selectedThreadId)`；`deleting` 已经是外壳算好的布尔量，判等挪到外壳去。

- [ ] **步骤 4：搬 JSX**

`AiChat.tsx` 的 `return (` 在 2155。JSX 的切分边界是连续的：

- **2270-2722** → `ConversationView` 的 return（对话区 + 输入框 + 各种浮层）
- 2156-2269 与 2723-2739 留给外壳（任务 4）

在 `ConversationView` 里，2270 之前的容器元素要补一个自己的根节点。用不带定位的语义类名：

```tsx
  return (
    <div className="ai-conversation">
      {/* 原 2270-2722 原样粘贴 */}
    </div>
  );
```

`.ai-conversation` 只做 `display: flex; flex-direction: column; min-height: 0; flex: 1;`，**不写任何 `position: fixed` / 宽高**——定位是外壳的事（任务 4/5 各自给外层容器定尺寸）。这条 CSS 放到任务 5 和外壳样式一起加。

- [ ] **步骤 5：改 `:222` 的断言**

`test/ai-chat-ui.test.mjs:222` 原本是：

```js
  assert.match(chatSource, /selectedHintRefreshQueue\.request\(selectedThreadId\)/);
```

改成：

```js
  assert.match(chatSource, /selectedHintRefreshQueue\.request\(threadId\)/);
```

这是 46 条断言里**唯一**需要改的一条（其余 45 条要么落在搬走的整块里、要么落在留下的整块里，拼接后原样命中）。

- [ ] **步骤 6：`AiChat.tsx` 挂上 `ConversationView`**

在 `AiChat.tsx` 里删掉搬走的部分，2270-2722 的位置换成：

```tsx
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
                onRequestClose={() => setPanelOpen(false)}
              />
```

- [ ] **步骤 7：跑类型检查与测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard
npx tsc --noEmit -p web/tsconfig.json
node --test test/ai-chat-ui.test.mjs 2>&1 | grep 'ℹ'
```

预期：`tsc` 无输出；`ℹ fail 0`。

`tsc` 这一步会集中暴露漏搬的引用（视图里用了留在外壳的变量，或反之）。按报错逐个决定：**这个变量该归谁**，然后要么搬过去，要么加成 prop。**不要**为了让 `tsc` 闭嘴而把外壳的状态整体复制一份到视图里——两份状态会各自漂移。

- [ ] **步骤 8：跑全量回归并 commit**

```bash
cd /home/work/vdc/dashi-taskboard
node --test $(ls test/*.test.mjs | grep -vE "cloud-|inject|task-editor") 2>&1 | grep 'ℹ'
git add web/src/components/ConversationView.tsx web/src/components/AiChat.tsx test/ai-chat-ui.test.mjs
git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
  commit -m "refactor: 抽出受控的 ConversationView（任务 3/10）"
```

预期：`ℹ fail 0`。

## 任务 4：`QuickChatPanel.tsx` 与 `AiChat.tsx` 门面

任务 3 之后 `AiChat.tsx` 里剩下的就是外壳。改名成 `QuickChatPanel`，`AiChat.tsx` 只留一个薄门面，这样 `App.tsx` 的 import 路径不用动。

**文件：**
- 创建：`web/src/components/QuickChatPanel.tsx`
- 修改：`web/src/components/AiChat.tsx`（缩成门面）
- 测试：`test/ai-chat-ui.test.mjs`

- [ ] **步骤 1：先写失败的测试**

追加：

```js
test("AiChat.tsx 只是门面，外壳逻辑在 QuickChatPanel.tsx", async () => {
  const facade = await readFile(
    new URL("../web/src/components/AiChat.tsx", import.meta.url),
    "utf8",
  );
  const shell = await readFile(
    new URL("../web/src/components/QuickChatPanel.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(facade.split("\n").length < 30, `门面应当很薄，实际 ${facade.split("\n").length} 行`);
  assert.match(facade, /export \{ QuickChatPanel as AiChat \}/);
  assert.match(shell, /export function QuickChatPanel\(/);
  assert.match(shell, /LAST_THREAD_KEY/);
  assert.match(shell, /<ConversationView/);
});
```

- [ ] **步骤 2：跑测试验证失败**

运行：`cd /home/work/vdc/dashi-taskboard && node --test test/ai-chat-ui.test.mjs 2>&1 | grep -E 'ℹ|ENOENT'`

预期：FAIL，报 `ENOENT ... QuickChatPanel.tsx`。

- [ ] **步骤 3：`git mv` 再改名**

```bash
cd /home/work/vdc/dashi-taskboard
git mv web/src/components/AiChat.tsx web/src/components/QuickChatPanel.tsx
```

在 `QuickChatPanel.tsx` 里：

- `export function AiChat({` → `export function QuickChatPanel({`
- `interface AiChatProps` → `export interface QuickChatPanelProps`（外部要用它的字段名，导出更省事）
- `AiChatOpenThreadRequest`(58) 保持原名不动，它是跨文件契约（`App.tsx:637` 用了）

- [ ] **步骤 4：新建门面 `AiChat.tsx`**

```tsx
// 历史上这个文件是 2741 行的「面板 + 对话视图」合体。
// 拆分后实体在 QuickChatPanel / ConversationView / AiChatMessages / TaskConversationModal，
// 这里只保留门面，避免调用方改 import 路径。
export { QuickChatPanel as AiChat } from "./QuickChatPanel";
export type { AiChatOpenThreadRequest } from "./QuickChatPanel";
export type { QuickChatPanelProps as AiChatProps } from "./QuickChatPanel";
```

- [ ] **步骤 5：跑类型检查与测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard
npx tsc --noEmit -p web/tsconfig.json
node --test test/ai-chat-ui.test.mjs 2>&1 | grep 'ℹ'
```

预期：`tsc` 无输出；`ℹ fail 0`。

若 `tsc` 报 `App.tsx` 找不到 `AiChatOpenThreadRequest`，说明门面的 `export type` 漏了；不要改 `App.tsx` 的 import，补门面。

- [ ] **步骤 6：确认四个文件的行数都进了可维护区间**

运行：`cd /home/work/vdc/dashi-taskboard && wc -l web/src/components/{AiChat,AiChatMessages,ConversationView,QuickChatPanel}.tsx`

预期：`AiChat.tsx` < 30；其余三个各自 < 1200，合计与拆分前的 2741 行同量级（允许因为 props 声明和 import 多出一两百行）。若 `ConversationView.tsx` 超过 1200 行，说明任务 2 有该搬进 `AiChatMessages.tsx` 的展示代码没搬——回到任务 2 补，不要在这里硬塞。

- [ ] **步骤 7：跑全量回归并 commit**

```bash
cd /home/work/vdc/dashi-taskboard
node --test $(ls test/*.test.mjs | grep -vE "cloud-|inject|task-editor") 2>&1 | grep 'ℹ'
git add web/src/components/AiChat.tsx web/src/components/QuickChatPanel.tsx test/ai-chat-ui.test.mjs
git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
  commit -m "refactor: 面板外壳独立成 QuickChatPanel，AiChat 降为门面（任务 4/10）"
```

预期：`ℹ fail 0`。

## 任务 5：`TaskConversationModal.tsx` 与卡片入口接线

规格 §7.6 说新代码只有三处：弹窗外壳、卡片菜单点进去的路由、「任务尚无会话」空态。本任务把三处一起做掉。

**文件：**
- 创建：`web/src/components/TaskConversationModal.tsx`
- 修改：`web/src/App.tsx`（`openTaskConversation`、弹窗挂载）
- 修改：`web/src/styles.css`（`.ai-conversation` + `.task-conversation-*`）
- 测试：`test/ai-chat-ui.test.mjs`

### 为什么空态不能放 `TaskConversationMenu`

`web/src/components/TaskConversationMenu.tsx`（168 行）在 `conversations.length === 0` 时直接 `return null`，整个入口按钮都不渲染。所以「任务尚无会话」只能由弹窗自己显示——也就是说卡片上**有会话才有入口**，空态出现的场景是「入口点开的瞬间会话被删了」或「thread 存在但 snapshot 取不到」。

### 为什么是居中弹窗不是右侧抽屉

`web/src/styles.css:6963` 的 `.ai-chat-panel` 已经是 `position: fixed; right: 8px; bottom: 8px; height: calc(100vh - 16px)`——右下角面板本身就是右侧全高抽屉。再做一个右侧抽屉，两个界面长得一样，分不出哪个是快捷对话哪个是任务对话。

- [ ] **步骤 1：先写失败的测试**

追加：

```js
test("任务对话弹窗是居中遮罩层，复用 ConversationView", async () => {
  const modalSource = await readFile(
    new URL("../web/src/components/TaskConversationModal.tsx", import.meta.url),
    "utf8",
  );
  assert.match(modalSource, /<ConversationView/);
  assert.match(modalSource, /readOnlyWhileRunning/);
  assert.match(modalSource, /task-conversation-backdrop/);
  assert.match(modalSource, /任务尚无会话/);
  // 弹窗不许碰后端私有信息，也不许出现原生 select（沿用既有约束）
  assert.doesNotMatch(modalSource, /origin\.workspacePath|codexThreadId|manageTaskboardSkillPath/);
  assert.doesNotMatch(modalSource, /<select/);
  assert.match(styles, /\.task-conversation-backdrop\s*\{/);
  assert.match(styles, /\.task-conversation-dialog\s*\{/);
  assert.match(styles, /width:\s*min\(1100px/);
  assert.match(styles, /height:\s*85vh/);
  assert.match(appSource, /<TaskConversationModal/);
});
```

- [ ] **步骤 2：跑测试验证失败**

运行：`cd /home/work/vdc/dashi-taskboard && node --test test/ai-chat-ui.test.mjs 2>&1 | grep -E 'ℹ|ENOENT'`

预期：FAIL，报 `ENOENT ... TaskConversationModal.tsx`。

- [ ] **步骤 3：写 `TaskConversationModal.tsx`**

```tsx
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
```

继续同一个文件：

```tsx
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
```

- [ ] **步骤 4：加样式**

追加到 `web/src/styles.css` 末尾。遮罩沿用 `.delete-backdrop`(4389-4398) 的既有观感（同样的 `rgba(13,14,16,0.32)` + `blur(1.5px)`），只是盒子大得多；`z-index: 90` 压在 `.delete-backdrop` 的 80 之上，因为弹窗里还可能弹危险确认框：

```css
.ai-conversation {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.task-conversation-backdrop {
  position: fixed;
  z-index: 90;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(13, 14, 16, 0.32);
  backdrop-filter: blur(1.5px);
}

.task-conversation-dialog {
  display: flex;
  flex-direction: column;
  width: min(1100px, 100%);
  height: 85vh;
  min-height: 0;
  overflow: hidden;
  border-radius: 12px;
  background: var(--surface-raised);
  box-shadow: var(--dialog-shadow);
}

.task-conversation-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-subtle);
}
```

```css
.task-conversation-title {
  font-size: 13px;
  font-weight: 600;
}

.task-conversation-close {
  border: 0;
  background: transparent;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 2px 6px;
}

.task-conversation-empty {
  margin: auto;
  font-size: 13px;
  opacity: 0.7;
}
```

上面用到 3 个自定义属性，先确认它们真的存在（`--surface-raised` 与 `--dialog-shadow` 来自 `.delete-dialog`，`--border-subtle` 需要核实）：

```bash
cd /home/work/vdc/dashi-taskboard && grep -n -- "--surface-raised:\|--dialog-shadow:\|--border-subtle:" web/src/styles.css
```

三个都有 → 照写。`--border-subtle` 没有 → 用 grep 出的实际边框变量名替换（`grep -n -- "--border" web/src/styles.css | head`），**不要**硬编码颜色值。

- [ ] **步骤 5：`App.tsx` 接线**

`App.tsx:2315-2333` 现在是：

```tsx
  function openTaskConversation(conversation: TaskConversationItem) {
    if (conversation.kind === "local-ai" && conversation.aiThreadId) {
      setAiOpenThreadRequest((current) => ({
        threadId: conversation.aiThreadId!,
        requestId: (current?.requestId ?? 0) + 1,
      }));
      return;
    }
    if (conversation.nativeThreadId) openThread(conversation.nativeThreadId);
  }
```

改成打开弹窗（本地 AI 会话进弹窗，codex 原生会话仍旧走 `codex://`）：

```tsx
  function openTaskConversation(conversation: TaskConversationItem) {
    if (conversation.kind === "local-ai") {
      setTaskConversation({
        threadId: conversation.aiThreadId ?? null,
        issueId: conversation.issueId,
      });
      return;
    }
    if (conversation.nativeThreadId) openThread(conversation.nativeThreadId);
  }
```

```tsx
  function openTaskConversation(conversation: TaskConversationItem) {
    if (conversation.kind === "local-ai") {
      setTaskConversation({ threadId: conversation.aiThreadId });
      return;
    }
    if (conversation.nativeThreadId) openThread(conversation.nativeThreadId);
  }
```

`TaskConversationItem`（`web/src/taskConversations.ts:8-18`）**没有 issueId 字段**，四个挂载点（`TaskCard.tsx:184`、`TaskCard.tsx:509`、`DashboardView.tsx:590`、`IssueListView.tsx:144`）也只传 `onOpenConversation`。这不影响功能：`issueId` 只在「草稿态新建 thread」时用得上，弹窗永远是打开已存在的 thread，传 `null` 即可。

配套的 state 加在 `aiOpenThreadRequest`(`App.tsx:637`) 旁边：

```tsx
  const [taskConversation, setTaskConversation] = useState<{ threadId: string | null } | null>(null);
```

挂载点放在 `openThreadRequest={aiOpenThreadRequest}`（`App.tsx:3343`）所在的那个 `<AiChat ... />` 后面，同一层：

```tsx
      <TaskConversationModal
        open={taskConversation !== null}
        threadId={taskConversation?.threadId ?? null}
        projectId={selectedProjectId}
        issueId={null}
        onClose={() => setTaskConversation(null)}
        onThreadsChange={() => void refreshAiThreads()}
      />
```

`refreshAiThreads` 用 `App.tsx` 里现成的那个（传给 `<AiChat onThreadsChange=...>` 的同一个回调）。如果它不是独立函数而是内联箭头，就先把它提成 `useCallback`，两处共用——**不要复制一份逻辑**。

- [ ] **步骤 6：跑类型检查与测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard
npx tsc --noEmit -p web/tsconfig.json
node --test test/ai-chat-ui.test.mjs 2>&1 | grep 'ℹ'
```

预期：`tsc` 无输出；`ℹ fail 0`。

- [ ] **步骤 7：跑全量回归并 commit**

```bash
cd /home/work/vdc/dashi-taskboard
node --test $(ls test/*.test.mjs | grep -vE "cloud-|inject|task-editor") 2>&1 | grep 'ℹ'
git add web/src/components/TaskConversationModal.tsx web/src/App.tsx web/src/styles.css test/ai-chat-ui.test.mjs
git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
  commit -m "feat: 新增居中的任务对话弹窗并接上卡片入口（任务 5/10）"
```

预期：`ℹ fail 0`。

## 任务 6：`readOnlyWhileRunning` 让弹窗在跑动中只读

规格 §7.4 要求「`in_progress`（有 running run）→ 输入框禁用，只读」。**现状没有这个行为**：`AiChat.tsx:1412-1414`（拆分后在 `ConversationView` 里）的 `composerBlocked` 只覆盖「正在删这条 thread」，跑动时只是发不出去（`primaryAction === "stop"` + `handleComposerKeyDown` 的提前 return），打字是允许的。

所以这是**新增一个可选开关**，不是改共享默认值——右下角快捷对话必须保留「跑动中也能打字、想好了等它停下再发」的既有手感。

**文件：**
- 修改：`web/src/components/ConversationView.tsx`
- 测试：`test/ai-chat-ui.test.mjs`

- [ ] **步骤 1：先写失败的测试**

追加：

```js
test("只有弹窗在跑动中锁输入框，快捷面板不受影响", async () => {
  const viewSource = await readFile(
    new URL("../web/src/components/ConversationView.tsx", import.meta.url),
    "utf8",
  );
  const shellSource = await readFile(
    new URL("../web/src/components/QuickChatPanel.tsx", import.meta.url),
    "utf8",
  );
  const modalSource = await readFile(
    new URL("../web/src/components/TaskConversationModal.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    viewSource,
    /const composerBlocked = Boolean\(\s*\(threadId && deleting\)\s*\|\|\s*\(readOnlyWhileRunning && currentRun\?\.status === "running"\),?\s*\);/,
  );
  // currentRun 必须在 composerBlocked 之前算出来
  assert.ok(viewSource.indexOf("const currentRun") < viewSource.indexOf("const composerBlocked"));
  assert.match(modalSource, /readOnlyWhileRunning\s*$|readOnlyWhileRunning\}/m);
  assert.doesNotMatch(shellSource, /readOnlyWhileRunning/);
});
```

- [ ] **步骤 2：跑测试验证失败**

运行：`cd /home/work/vdc/dashi-taskboard && node --test test/ai-chat-ui.test.mjs 2>&1 | grep -E 'ℹ|composerBlocked'`

预期：FAIL，第一条 `assert.match` 不通过（当前只有 `Boolean(threadId && deleting)`）。

- [ ] **步骤 3：实现**

在 `ConversationView` 的参数解构里加上 `readOnlyWhileRunning`（任务 3 只在 `ConversationViewProps` 里声明了它，没有解构），然后把 `composerBlocked` 改成：

```tsx
  const composerBlocked = Boolean(
    (threadId && deleting) || (readOnlyWhileRunning && currentRun?.status === "running"),
  );
```

`currentRun` 在 `composerBlocked` 之前几行就算好了（拆分前是 `AiChat.tsx:1408` vs `1412`），顺序天然满足，不用挪。

`composerBlocked` 已经被 `sendBlocked` 和 `attachmentBlocked` 吃进去了，所以发送、附件、粘贴一并禁用，不需要再改别处。

- [ ] **步骤 4：跑类型检查与测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard
npx tsc --noEmit -p web/tsconfig.json
node --test test/ai-chat-ui.test.mjs 2>&1 | grep 'ℹ'
```

预期：`tsc` 无输出；`ℹ fail 0`。

- [ ] **步骤 5：跑全量回归并 commit**

```bash
cd /home/work/vdc/dashi-taskboard
node --test $(ls test/*.test.mjs | grep -vE "cloud-|inject|task-editor") 2>&1 | grep 'ℹ'
git add web/src/components/ConversationView.tsx test/ai-chat-ui.test.mjs
git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
  commit -m "feat: 任务对话弹窗在 run 跑动中只读（任务 6/10）"
```

预期：`ℹ fail 0`。

## 任务 7：`blocked` 的中文标签改成「等你回答」

规格 §7.1：看板从 3 条泳道变 4 条，顺序 `待处理 → 处理中 → 等你回答 → 等你确认`，「等你回答」**复用现有 `blocked` 状态**，不新增枚举值（SQLite 改 CHECK 要建新表拷数据）。

代价是状态名与泳道名对不上，必须在代码里注释说明。

**已经不用做的部分**：泳道顺序和条件隐藏在 A2 之前就已经是对的——`test/other-tasks-panel.test.mjs:27` 钉了 `MAIN_STATUSES` 就是 `["todo","in_progress","blocked","in_review"]`，`App.tsx:1848-1851` 的 `hasBlockedTasks` 条件隐藏也在。本任务**只改标签文案**，`hasBlockedTasks` 那段条件隐藏保留不动（阶段一没有 askQuestion，这一列会一直是空的，空着就不显示是对的）。

**文件（6 处源码 + 2 处测试断言，`grep -rn "遇到阻碍"` 的全集）：**

| 文件:行 | 改成 |
|---|---|
| `web/src/i18n.tsx:31` | `blocked: "等你回答",` |
| `web/src/components/BoardColumn.tsx:21` | `blocked: { label: "等你回答", tone: "blocked" },` |
| `web/src/components/workflowCatalog.ts:62` | `{ value: "blocked", label: "等你回答" },` |
| `web/src/components/GanttView.tsx:48` | `chineseLabel: "等你回答"` |
| `web/src/components/workflowI18n.ts:16` | `"等你回答": "Blocked",`（这是 zh→en 的**键**，不跟着改就查不到译文） |
| `server/project-summary.mjs:11` | `blocked: "等你回答",` |
| `test/other-tasks-panel.test.mjs:35` | 断言里的字面量 |
| `test/board-interactions.test.mjs:101` | 断言里的字面量 |

英文侧一律保持 `Blocked` 不变（`i18n.tsx:40`、`GanttView.tsx:48` 的 `englishLabel`、`workflowI18n.ts` 的值）——英文语境里 `Blocked` 本来就没有「遇到阻碍」那层过强的失败暗示。

- [ ] **步骤 1：先改测试，验证失败**

把 `test/other-tasks-panel.test.mjs:35` 和 `test/board-interactions.test.mjs:101` 两处（内容完全相同）：

```js
  assert.match(boardColumnSource, /blocked: \{ label: "遇到阻碍", tone: "blocked" \}/);
```

改成：

```js
  assert.match(boardColumnSource, /blocked: \{ label: "等你回答", tone: "blocked" \}/);
```

运行：

```bash
cd /home/work/vdc/dashi-taskboard
node --test test/other-tasks-panel.test.mjs test/board-interactions.test.mjs 2>&1 | grep 'ℹ'
```

预期：FAIL，`ℹ fail 2`。

- [ ] **步骤 2：改 6 处源码**

按上表逐个改。`web/src/i18n.tsx:25-44` 的 `STATUS_LABELS` 是可见文案的真源（`taskStatusLabel(language, status)` 从这里取），改的时候在它上面加一行注释说明这个错位：

```tsx
const STATUS_LABELS: Record<TaskboardLanguage, Record<TaskStatus, string>> = {
  zh: {
    backlog: "待立项",
    todo: "等待认领",
    in_progress: "处理中",
    in_review: "等你确认",
    // 底层枚举仍叫 blocked（扩 CHECK 约束要重建表），
    // 语义已收窄为「agent 提了问题，在等你回答」，泳道位于「处理中」与「等你确认」之间
    blocked: "等你回答",
    done: "完成",
    canceled: "取消",
  },
```

`BoardColumn.tsx:21` 的 `label` 字段其实**没有任何代码读它**（只有 `.tone` 被用到），但两个测试钉了这个字面量，所以必须同步改，不改就红。顺手在 `STATUS_DETAILS` 上加一行注释说明 `label` 未被读取，避免下一个人以为改了这里就能改界面。

- [ ] **步骤 3：跑测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard
node --test test/other-tasks-panel.test.mjs test/board-interactions.test.mjs test/board-views.test.mjs 2>&1 | grep 'ℹ'
grep -rn "遇到阻碍" web/ test/ server/ shared/ || echo "已无残留"
```

预期：`ℹ fail 0`；grep 输出 `已无残留`。

有残留说明漏了一处；`workflowI18n.ts` 的键最容易漏，漏了的表现是工作流界面上这个状态的英文译文丢失（回落显示中文）。

- [ ] **步骤 4：跑全量回归并 commit**

```bash
cd /home/work/vdc/dashi-taskboard
npx tsc --noEmit -p web/tsconfig.json
node --test $(ls test/*.test.mjs | grep -vE "cloud-|inject|task-editor") 2>&1 | grep 'ℹ'
git add web/src/i18n.tsx web/src/components/BoardColumn.tsx web/src/components/workflowCatalog.ts \
  web/src/components/GanttView.tsx web/src/components/workflowI18n.ts server/project-summary.mjs \
  test/other-tasks-panel.test.mjs test/board-interactions.test.mjs
git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
  commit -m "feat: blocked 泳道改名「等你回答」（任务 7/10）"
```

预期：`tsc` 无输出；`ℹ fail 0`。

## 任务 8：`api.ts` 接上自动化配置接口

A2 任务 11 已经在 `server/app.mjs` 里加了 `GET/PATCH /api/projects/:id/automation`。契约（照抄 A2 的实现，不要重新设计）：

| | |
|---|---|
| 响应形状 | `{ automation: { enabledByUser, intervalMinutes, model, reasoningEffort } }` |
| 默认值 | `{ enabledByUser: false, intervalMinutes: 5, model: null, reasoningEffort: null }` |
| PATCH 语义 | **浅合并**，只传要改的键 |
| `quotaAware` 出现在 body | 400 `INVALID_FIELD`（`assertAllowedKeys` 只放行那 4 个键） |
| `intervalMinutes` 非正整数 | 400 |
| 项目不存在 | 404 |
| 其他 method | 405 |

**文件：**
- 修改：`web/src/types.ts`（加 `ProjectAutomation`）
- 修改：`web/src/api.ts`（加两个函数）
- 测试：`test/project-automation-settings.test.mjs`

- [ ] **步骤 1：先写失败的测试**

在 `test/project-automation-settings.test.mjs` 末尾追加（该文件已有 `apiSource` 就复用，没有就照 `test/ai-chat-ui.test.mjs:24` 的写法加一个）：

```js
test("自动化配置走 HTTP 接口而不是 host message", async () => {
  const apiText = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
  assert.match(apiText, /export async function getProjectAutomation\(/);
  assert.match(apiText, /export async function updateProjectAutomation\(/);
  assert.match(apiText, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/automation/);
  assert.match(apiText, /method: "PATCH"/);
  const typesText = await readFile(new URL("../web/src/types.ts", import.meta.url), "utf8");
  assert.match(typesText, /export interface ProjectAutomation \{/);
  for (const field of ["enabledByUser", "intervalMinutes", "model", "reasoningEffort"]) {
    assert.match(typesText, new RegExp(`${field}:`));
  }
  assert.doesNotMatch(typesText, /quotaAware/);
});
```

- [ ] **步骤 2：跑测试验证失败**

运行：`cd /home/work/vdc/dashi-taskboard && node --test test/project-automation-settings.test.mjs 2>&1 | grep 'ℹ'`

预期：FAIL。

- [ ] **步骤 3：加类型**

追加到 `web/src/types.ts`：

```ts
/** 服务端 projects.automation_options 的形状，见 server/app.mjs 的 /api/projects/:id/automation */
export interface ProjectAutomation {
  enabledByUser: boolean;
  intervalMinutes: number;
  /** null = 跟随所选后端的默认模型，不写死 slug */
  model: string | null;
  reasoningEffort: string | null;
}
```

- [ ] **步骤 4：加两个函数**

追加到 `web/src/api.ts`（形状照 `createProjectLabel`:401-410，`request` 会自动补 `Content-Type` 与 `X-Taskboard-User-*` 头）：

```ts
export async function getProjectAutomation(projectId: string): Promise<ProjectAutomation> {
  const data = await request<{ automation: ProjectAutomation }>(
    `/api/projects/${encodeURIComponent(projectId)}/automation`,
  );
  return data.automation;
}

export async function updateProjectAutomation(
  projectId: string,
  changes: Partial<ProjectAutomation>,
): Promise<ProjectAutomation> {
  const data = await request<{ automation: ProjectAutomation }>(
    `/api/projects/${encodeURIComponent(projectId)}/automation`,
    {
      method: "PATCH",
      body: JSON.stringify(changes),
    },
  );
  return data.automation;
}
```

`changes` 用 `Partial` 是因为服务端就是浅合并；**不要**在前端补全 4 个键再发，那样会把没动的字段也覆盖一遍，多人/多标签页同时改时会互相回退。

`ProjectAutomation` 要加进 `api.ts` 顶部那条从 `./types` 的 import 里。

- [ ] **步骤 5：跑类型检查与测试验证通过，然后 commit**

```bash
cd /home/work/vdc/dashi-taskboard
npx tsc --noEmit -p web/tsconfig.json
node --test test/project-automation-settings.test.mjs 2>&1 | grep 'ℹ'
git add web/src/types.ts web/src/api.ts test/project-automation-settings.test.mjs
git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
  commit -m "feat: api.ts 接上项目自动化配置接口（任务 8/10）"
```

预期：`tsc` 无输出；`ℹ fail 0`。

## 任务 9：`ProjectAutomationMenu` 去掉 `quotaAware` 与写死的 codex 模型

**文件：**
- 修改：`web/src/components/ProjectAutomationMenu.tsx`
- 测试：`test/project-automation-settings.test.mjs`

规格 §8.3：`quotaAware` 依赖 codex app 提供额度信息，脱离 app 后没有实现依托 → **删掉**；`model` 默认值 `"gpt-5.5"` 是 codex 的模型名，后端默认改 ducc 后要跟 catalog 走，不写死。

**`shared/taskboard-automation-options.mjs` 本体不动**（69 行）。它被 `shared/taskboard-automation.mjs`(222 行) 引用，后者又被 `scripts/codex-injector.mjs:17` 引用，而规格 §10.3 要求保留整条 injector 链路可回退。本任务只删**这个文件里**的 import。

- [ ] **步骤 1：先改测试，验证失败**

改 `test/project-automation-settings.test.mjs` 的 4 处：

1. `:69` `assert.match(menuSource, /AUTOMATION_MODELS\.map/)` → `assert.match(menuSource, /models\.map/)`
2. `:94-101` 整个 `draft.quotaAware` 开关的断言块 → 换成反向断言：

```js
  assert.doesNotMatch(menuSource, /quotaAware/);
  assert.doesNotMatch(menuSource, /taskboard-automation-options/);
  assert.doesNotMatch(menuSource, /gpt-5\.5/);
  assert.match(menuSource, /models: AiChatModel\[\]/);
```

3. `:107` `assert.equal(menuSource.match(/disabled=\{disabled\}/g)?.length, 5)` → 改成 `4`（删掉的额度开关正好是第 5 个）
4. **只替换 `:123-125` 这 3 行**（`submitChange(withAutomationModel(...))` / `getAutomationModel(draft.model).efforts.map` / 写死 `text(...EFFORT_LABELS[effort])` 的那行 `<option>`），换成从 catalog 取强度。`:120-122`（props 契约、`disabled`、`submitChange`）和 `:126-135`（6 个强度中文标签 + 4 条「没有保存/取消按钮」的反向断言）**保持原样不动** —— 那些约束在新世界里依然成立，删掉就是白白削弱测试：

```js
  assert.match(
    menuSource,
    /submitChange\(\{ \.\.\.draft, model: event\.target\.value \|\| null, reasoningEffort: null \}\)/,
  );
  assert.match(menuSource, /supportedReasoningEfforts/);
  assert.match(menuSource, /defaultReasoningEffort/);
  assert.doesNotMatch(menuSource, /withAutomationModel|getAutomationModel/);
```

另外 `:61` `status === "ACTIVE" ? "automationPause" : "automationPlay"`、`:65` 的 `aria-label`、`:94/96` 的 `draft.enabledByUser` 开关断言都**不改** —— 新实现保留 `status` 这个派生量，只是改成从 `automation?.enabledByUser` 推。`:70` 的 `/EFFORT_LABELS\[effort\]/` 在另一个 test（`:60-80`）里，本步只改它同 test 的 `:69`；新实现用 `EFFORT_LABELS[effort] ?? [effort, effort]` 兜底未知强度，`EFFORT_LABELS[effort]` 子串仍在，`:70` 不用改。

运行：`cd /home/work/vdc/dashi-taskboard && node --test test/project-automation-settings.test.mjs 2>&1 | grep 'ℹ'`

预期：FAIL。

- [ ] **步骤 2：改 `ProjectAutomationMenu.tsx` 的 import、类型与派生量**

把 `:1-59` 整段替换成：

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TaskboardIcon } from "./TaskboardIcon";
import { useTaskboardI18n } from "../i18n";
import type { AiChatModel } from "../types";

type AutomationStatus = "ACTIVE" | "PAUSED";

export interface AutomationOptions {
  enabledByUser: boolean;
  intervalMinutes: number;
  /** null = 跟随所选后端的默认模型，不写死 slug */
  model: string | null;
  /** null = 跟随所选模型的 defaultReasoningEffort */
  reasoningEffort: string | null;
}

interface ProjectAutomationMenuProps {
  automation?: Partial<AutomationOptions>;
  models: AiChatModel[];
  pending: boolean;
  error: string | null;
  unavailableReason: string | null;
  onOpen: () => void;
  onChange: (options: AutomationOptions) => void;
}

const DEFAULT_OPTIONS: AutomationOptions = {
  enabledByUser: false,
  intervalMinutes: 5,
  model: null,
  reasoningEffort: null,
};

// 各后端的强度取值不是同一套（codex 六档、ducc 目前只有 medium），
// 所以这张表是「已知取值的中文名」而非枚举，未知取值原样显示。
const EFFORT_LABELS: Record<string, readonly [string, string]> = {
  low: ["轻度", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  xhigh: ["极高 (xhigh)", "Extra high (xhigh)"],
  max: ["最高", "Maximum"],
  ultra: ["极高 (ultra)", "Ultra"],
};
```

三处类型收窄被刻意放开：`intervalMinutes` 从 `5 | 10 | 15 | 30 | 60` 改成 `number`（服务端只校验正整数，见任务 8 的契约表；不放开的话任务 10 传 `ProjectAutomation.intervalMinutes: number` 会类型不匹配），`model` / `reasoningEffort` 从 codex 的字符串联合改成 `string | null`。`AutomationQuotaState` / `AutomationState` / `IntervalMinutes` 三个类型连同 `quota` 字段一起删掉。

然后改函数签名与派生量，`:61-89`：

```tsx
export function ProjectAutomationMenu({
  automation,
  models,
  pending,
  error,
  unavailableReason,
  onOpen,
  onChange,
}: ProjectAutomationMenuProps) {
  const { text } = useTaskboardI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasPendingRef = useRef(pending);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [draft, setDraft] = useState<AutomationOptions>(DEFAULT_OPTIONS);
  // 原来的 status 来自 codex app 的 automation item，脱离 app 后没有这个信息源，
  // 唯一真源就是用户自己的开关。
  const status: AutomationStatus = automation?.enabledByUser ? "ACTIVE" : "PAUSED";
  const stateLabel = status === "ACTIVE"
    ? text("运行中", "Running")
    : text("已暂停", "Paused");
  const disabled = pending || Boolean(unavailableReason);
  const selectedModel = models.find((model) => model.slug === draft.model) ?? null;
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];
```

注意 `locale` 从 `useTaskboardI18n()` 的解构里去掉了 —— 它唯一的用处是格式化额度重置时间，`formatResetTime`(`:300-307`) 连同它一起删。不删会被 `noUnusedLocals` 拦下。

`status` 这个派生量必须留：`test/project-automation-settings.test.mjs:61` 钉了 `status === "ACTIVE" ? "automationPause" : "automationPlay"`，`:65` 钉了 `aria-label`。它现在只是 `enabledByUser` 的别名，但改掉这两处断言等于把图标契约的测试一起删了，不值得。

- [ ] **步骤 3：删掉额度 UI，模型与强度下拉改走 catalog**

删除 `:178-218` 整段（额度开关 `<div className="project-automation-switch">` + `{draft.quotaAware && (...)}` 那块提示）。删完 `disabled={disabled}` 从 5 处降到 4 处，正好对上步骤 1 改的断言。

模型下拉 `:234-245` 换成：

```tsx
      <label className="project-automation-field">
        <span>{text("模型", "Model")}</span>
        <select
          value={draft.model ?? ""}
          disabled={disabled}
          onChange={(event) => submitChange({ ...draft, model: event.target.value || null, reasoningEffort: null })}
        >
          <option value="">{text("跟随后端默认", "Backend default")}</option>
          {models.map((model) => (
            <option key={model.slug} value={model.slug}>{model.displayName}</option>
          ))}
        </select>
      </label>
```

换模型时把 `reasoningEffort` 一并置 `null`：新模型的 `supportedReasoningEfforts` 可能不含旧强度，留着就是一个下拉里选不中的值。这条正是原来 `withAutomationModel` 干的事，只是不再需要一张写死的映射表。

强度下拉 `:246-260` 换成：

```tsx
      <label className="project-automation-field">
        <span>{text("推理强度", "Reasoning effort")}</span>
        <select
          value={draft.reasoningEffort ?? selectedModel?.defaultReasoningEffort ?? ""}
          disabled={disabled}
          onChange={(event) => submitChange({ ...draft, reasoningEffort: event.target.value || null })}
        >
          <option value="">{text("跟随模型默认", "Model default")}</option>
          {efforts.map((effort) => (
            <option key={effort} value={effort}>{text(...(EFFORT_LABELS[effort] ?? [effort, effort]))}</option>
          ))}
        </select>
      </label>
```

`models` 为空数组时（catalog 还没拉回来、或后端不可用）两个下拉都只剩「跟随默认」一项，不会崩也不会显示假模型名。

- [ ] **步骤 4：给 `App.tsx` 现有挂载点加临时适配层**

`models` 是必填 prop、`AutomationOptions` 的形状也变了，`App.tsx:2727-2733` 那个挂载点会立刻类型不通。任务 10 才会把 App 的整套 host message 机制拆掉，所以这一步只加一层**明确标注要在任务 10 删掉**的适配：

```tsx
              <ProjectAutomationMenu
                automation={selectedProjectAutomation}
                // 任务 10 接上 getAiChatCatalog()，在那之前下拉里只有「跟随默认」
                models={[]}
                pending={automationPending}
                error={automationError}
                unavailableReason={automationProjectContext.unavailableReason}
                onOpen={() => void reconcileProjectAutomation()}
                // 任务 10 删掉这层适配：那时 saveProjectAutomation 直接吃新形状
                onChange={(options) => void saveProjectAutomation({
                  ...options,
                  quotaAware: false,
                  intervalMinutes: options.intervalMinutes as AutomationIntervalMinutes,
                  model: (options.model ?? "gpt-5.5") as AutomationModel,
                  reasoningEffort: (options.reasoningEffort ?? "high") as AutomationReasoningEffort,
                })}
              />
```

三个 `as` 断言都是现成类型，不用加 import：`AutomationIntervalMinutes` 在 `App.tsx:199`，`AutomationModel` / `AutomationReasoningEffort` 在 `App.tsx:15-20` 已经从 `shared/taskboard-automation-options.mjs` 导入。适配层拼出来的形状就是 `ProjectAutomationOptions`(`:220-223`)。

这两个 commit 之间自动化菜单处于半拆状态：能开、能改间隔、模型下拉是空的，改动仍然走老的 host message 打给 codex app。这是刻意的中间态，不是遗漏。

- [ ] **步骤 5：跑类型检查与测试验证通过，然后 commit**

```bash
cd /home/work/vdc/dashi-taskboard
npx tsc --noEmit -p web/tsconfig.json
node --test test/project-automation-settings.test.mjs 2>&1 | grep 'ℹ'
git add web/src/components/ProjectAutomationMenu.tsx web/src/App.tsx \
  test/project-automation-settings.test.mjs
git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
  commit -m "refactor: 自动化菜单删掉额度开关，模型与强度改走 catalog（任务 9/10）"
```

预期：`tsc` 无输出；`ℹ fail 0`。

## 任务 10：`App.tsx` 拆掉 host message 链路，自动化配置改走 HTTP

**文件：**
- 修改：`web/src/App.tsx`
- 测试：`test/project-automation-settings.test.mjs`

规格 §1 描述的链路是：网页 `postEmbeddedHostMessage({type:"taskboard:automation-request"})` → `scripts/codex-injector.mjs` 用 CDP `Runtime.evaluate` 调 `window.electronBridge.sendMessageFromView` → `vscode://codex/<method>`。整条链路要求 codex app 正在运行。本任务把网页这一端换成任务 8 那两个 HTTP 函数。

`scripts/codex-injector.mjs` 和 `shared/taskboard-automation.mjs` **一行不动**（规格 §10.3 要求保留可回退），只是不再有人从网页触发它们。

- [ ] **步骤 1：先改测试，验证失败**

`test/project-automation-settings.test.mjs` 里 4 个 test 整体删掉，换成 1 个新 test；其余 6 个 test 保持（其中两个已在任务 9 改过）。

删除：
- `:24-34` `project automation state is device-local and scoped by taskboard project` —— 整个前提（localStorage）不复存在
- `:36-51` `automation requests use the exact Codex host message contract`
- `:53-58` `project mapping is based on exact ids and workspace paths, never project names`
- `:147-175` `opening settings and changing projects reconcile with the host list`

在 `:24` 的位置插入：

```js
test("project automation state comes from the server, not device storage or the Codex host", () => {
  assert.doesNotMatch(appSource, /PROJECT_AUTOMATIONS_KEY/);
  assert.doesNotMatch(appSource, /taskboard:automation-request/);
  assert.doesNotMatch(appSource, /taskboard:automation-response/);
  assert.doesNotMatch(appSource, /quotaAware/);
  assert.doesNotMatch(appSource, /taskboard-automation-options/);
  assert.doesNotMatch(appSource, /intervalMinutesFromRrule|isAutomationHostItem|isAutomationHostPolicy/);
  assert.match(appSource, /getProjectAutomation\(selectedProjectId\)/);
  assert.match(appSource, /updateProjectAutomation\(selectedProjectId, changes\)/);
  assert.match(appSource, /getAiChatCatalog\(selectedProjectId\)/);
  assert.match(appSource, /models=\{automationModels\}/);
});
```

再把 `:104-117` 那个 test 里 `:108-116` 的 `reconcileSource` 切片断言（`const reconcileProjectAutomation` / `const saveProjectAutomation` 两个锚点都会消失）换成：

```js
  assert.match(appSource, /if \(automationUnavailableReason \|\| !selectedProjectId\) return;/);
  assert.match(appSource, /const automationUnavailableReason = useMemo\(/);
```

运行：`cd /home/work/vdc/dashi-taskboard && node --test test/project-automation-settings.test.mjs 2>&1 | grep 'ℹ'`

预期：FAIL。

- [ ] **步骤 2：删掉 host 链路的类型、常量与纯函数**

`App.tsx` 顶部这几段整体删除：

| 位置 | 内容 | 为什么能删 |
|---|---|---|
| `:15-20` | 从 `../../shared/taskboard-automation-options.mjs` 导入的 `isAutomationModel` / `isAutomationReasoningEffort` / `type AutomationModel` / `type AutomationReasoningEffort` | 两个 guard 只在 `:383-384`、`:432-433`、`:459-460` 被调用，全在本步要删的 helper 里；两个 type 只被本步要删的类型别名引用 |
| `:197-270` | `ProjectAutomationStatus` / `AutomationQuotaState` / `AutomationIntervalMinutes` / `AutomationQuotaStatus` / `ProjectAutomationRecord` / `ProjectAutomationOptions` / `AutomationRequestContext` / `QueuedProjectAutomationSave` / `ProjectAutomations` / `AutomationHostItem` / `AutomationHostResponse` / `PendingAutomationRequest` 共 12 个声明 | 全是 host message 协议或 localStorage 存储结构的形状，换 HTTP 后没有一个还有对应物 |
| `:283` | `const PROJECT_AUTOMATIONS_KEY = ...` | localStorage key |
| `:286-292` | `DEFAULT_AUTOMATION_OPTIONS`（含 `model: "gpt-5.5"`、`reasoningEffort: "high"`） | 默认值改由服务端给（任务 8 的 `GET` 返回已经带默认），规格 §8.3 明确要求不再写死 codex 的模型名 |
| `:366-407` | `readProjectAutomations` | localStorage 读取 |
| `:409-421` | `isAutomationQuotaStatus` | 额度信息随 `quotaAware` 一起删（规格 §8.3） |
| `:423-436` | `isAutomationHostPolicy` | host 响应校验 |
| `:438-440` | `isAutomationIntervalMinutes` | 间隔类型从字面量联合放宽成 `number`（任务 9 已改），不需要 guard |
| `:442-445` | `intervalMinutesFromRrule` | 解析 codex app 的 `RRULE:FREQ=MINUTELY;INTERVAL=N` |
| `:453-465` | `isAutomationHostItem` | host 响应校验 |

**`:447-451` 的 `workspaceName` 保留不动。** 它与自动化无关，被项目选择器用着。删了会引出一串编译错误，很容易误判成自己改错了。

`GLOBAL_PROJECT_ID`(`:279`) 也保留 —— 它不是自动化专用的。

- [ ] **步骤 3：删掉 host 链路的 state、ref、useMemo、回调与消息监听**

组件体内这几段整体删除：

| 位置 | 内容 |
|---|---|
| `:712-714` | `projectAutomations` / `automationPending` / `automationError` 三个 state（`:711` 的 `deviceWorkspacePaths` **保留**，它给项目选择器用） |
| `:742-746` | `pendingAutomationRequestsRef` / `automationRequestInFlightRef` / `loadedAutomationProjectIdsRef` / `queuedAutomationSavesRef` / `projectAutomationsRef` 五个 ref |
| `:797` | `selectedProjectAutomation` |
| `:798-845` | `automationProjectContext` useMemo |
| `:846-860` | `automationRequestContext` useMemo |
| `:951-977` | `writeProjectAutomation` |
| `:979-1015` | `sendAutomationRequest` |
| `:1017-1060` | `drainQueuedAutomationSaves` |
| `:1062-1158` | `reconcileProjectAutomation` |
| `:1160-1174` | `saveProjectAutomation`（步骤 4 会写一个同名的新版） |
| `:1338-1341` | 项目切换时调 `reconcileProjectAutomation` 的 effect（步骤 4 会写一个新 effect 顶上） |
| `:1366-1380` | `[embedded, host]` 那个 effect 里处理 `taskboard:automation-response` 的分支 |
| `:1416-1423` | 同一个 effect 的 `return () => {...}` 里对应的清理代码 |

删 `:1366-1380` 和 `:1416-1423` 时只删自动化那一段，effect 本身和它处理的其它 host message 类型都要留着 —— 这个 effect 还承担别的职责。

`errorMessage`（`:734` 附近的内联定义）保留，步骤 4 要用。

- [ ] **步骤 4：写新的 state、可用性判定、加载与保存**

在原 `:712-714` 的位置写新 state：

```tsx
  const [projectAutomation, setProjectAutomation] = useState<ProjectAutomation | null>(null);
  const [automationModels, setAutomationModels] = useState<AiChatModel[]>([]);
  const [automationPending, setAutomationPending] = useState(false);
  const [automationError, setAutomationError] = useState<string | null>(null);
```

在原 `:797-860`（三段 useMemo）的位置写单一的可用性判定：

```tsx
  const automationUnavailableReason = useMemo(() => {
    if (!isLocalTaskboardOrigin(new URL(document.baseURI).origin)) {
      return text("仅本地任务面板可用", "Available only on the local taskboard");
    }
    if (!selectedProject) return text("请先选择项目", "Select a project first");
    if (!selectedProject.workspacePath) {
      return text("请先为该项目设置工作区目录", "Set a workspace directory for this project first");
    }
    return null;
  }, [selectedProject, text]);
```

原来的 5 个不可用分支里，「请先在 Codex 中添加并映射该项目目录」(`:827`) 这一条随 host 链路一起消失 —— 判据从「codex app 里有没有映射」变成「`projects.workspace_path` 有没有值」，这正是规格 §8.4 要求的替换。全局项目 `local` 的 `workspace_path` 是 `NULL`（`server/database.mjs:750`），会落到第三个分支，符合预期：全局项目没有工作区，跑不了自动化。

在原 `:951-1174` 的位置写两个回调：

```tsx
  const loadProjectAutomation = useCallback(async () => {
    if (automationUnavailableReason || !selectedProjectId) {
      setProjectAutomation(null);
      return;
    }
    setAutomationPending(true);
    try {
      const [automation, catalog] = await Promise.all([
        getProjectAutomation(selectedProjectId),
        getAiChatCatalog(selectedProjectId),
      ]);
      setProjectAutomation(automation);
      setAutomationModels(catalog.models);
      setAutomationError(null);
    } catch (error) {
      setAutomationError(errorMessage(error));
    } finally {
      setAutomationPending(false);
    }
  }, [automationUnavailableReason, selectedProjectId]);

  const saveProjectAutomation = useCallback(async (changes: AutomationOptions) => {
    if (automationUnavailableReason || !selectedProjectId) return;
    setProjectAutomation((current) => (current ? { ...current, ...changes } : current));
    setAutomationPending(true);
    try {
      setProjectAutomation(await updateProjectAutomation(selectedProjectId, changes));
      setAutomationError(null);
    } catch (error) {
      setAutomationError(errorMessage(error));
      await loadProjectAutomation();
    } finally {
      setAutomationPending(false);
    }
  }, [automationUnavailableReason, loadProjectAutomation, selectedProjectId]);
```

`saveProjectAutomation` 先乐观更新再落库，失败时用 `loadProjectAutomation()` 拉回真值 —— 菜单里的开关是即时反馈的（任务 9 的 `submitChange` 直接 `setDraft` 后调 `onChange`），等一个来回会闪。

在原 `:1338-1341` 的位置写新 effect：

```tsx
  useEffect(() => {
    setAutomationError(null);
    void loadProjectAutomation();
  }, [selectedProjectId, loadProjectAutomation]);
```

补 import：

```tsx
import { getAiChatCatalog, getProjectAutomation, updateProjectAutomation } from "./api";
import type { AiChatModel, ProjectAutomation } from "./types";
import type { AutomationOptions } from "./components/ProjectAutomationMenu";
```

这三行是示意，实际要合并进 `App.tsx` 已有的 `./api` / `./types` import 语句里，不要新增重复的 from 子句。`getAiChatCatalog` 是既有函数（任务 8 只加了两个自动化函数），先 grep 确认它是否已经在 `App.tsx` 的 `./api` import 里，已在就不重复加。

- [ ] **步骤 5：改挂载点，删掉任务 9 的临时适配层**

把 `App.tsx:2727-2734` 替换成：

```tsx
              <ProjectAutomationMenu
                automation={projectAutomation ?? undefined}
                models={automationModels}
                pending={automationPending}
                error={automationError}
                unavailableReason={automationUnavailableReason}
                onOpen={() => void loadProjectAutomation()}
                onChange={(options) => void saveProjectAutomation(options)}
              />
```

`{selectedProjectId && (...)}` 的外层守卫保留。`automation` 用 `?? undefined` 是因为 prop 声明成 `automation?: Partial<AutomationOptions>`（任务 9），`null` 不匹配可选属性。

任务 9 步骤 4 那 6 行带 `as` 断言的适配代码到此全部消失，这也是那三个 `as` 类型的最后使用者 —— 步骤 2 删掉 `:15-20` 的 import 之后类型检查应当是干净的。

- [ ] **步骤 6：跑类型检查与全量回归验证通过，然后 commit**

```bash
cd /home/work/vdc/dashi-taskboard
npx tsc --noEmit -p web/tsconfig.json
node --test $(ls test/*.test.mjs | grep -vE "cloud-|inject|task-editor") 2>&1 | grep 'ℹ'
git add web/src/App.tsx test/project-automation-settings.test.mjs
git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
  commit -m "feat: 自动化配置改走 HTTP 接口，脱离 codex app host message（任务 10/10）"
```

预期：`tsc` 无输出；`ℹ fail 0`。

`tsc` 若报 `'xxx' is declared but its value is never read`，说明步骤 2/3 有漏删 —— `noUnusedLocals` 是打开的，按报错位置补删即可，不要加 `// eslint-disable` 或改 tsconfig。

## 已知限制（本计划有意留下的，不是漏做）

| 限制 | 出处 | 说明 |
|---|---|---|
| 「等你回答」泳道平时不显示 | 任务 7 | 规格 §10.1 明确：阶段一没有 askQuestion，没有任何代码路径会把任务置成 `blocked`。`App.tsx:1848-1851` 的 `hasBlockedTasks` 会在没有 blocked 任务时把这一列隐藏，所以正常情况下看板还是 3 列 —— 只有手工把任务拖进 `blocked` 才会出现第 4 列。本任务只改文案，不动这个条件隐藏 |
| 弹窗里跑动中只读，不能插话 | 任务 6 | 规格 §10.1，插话与 askQuestion 共用同一个未验证的 stdin `control_response` 通道（规格 §11）。现在的实现只是禁用输入框，没有排队机制 |
| 快捷对话面板仍然允许跑动中打字 | 任务 6 | `readOnlyWhileRunning` 是 opt-in 的，只有任务对话弹窗传 `true`。快捷对话保持现有手感不变，避免这次拆分顺带改掉一个没人抱怨的行为 |
| 自动化菜单不再显示额度信息 | 任务 9 | 规格 §8.3 / §10.2：额度数字来自 codex app 的 automation item，脱离 app 后没有实现依托。`quotaAware` 开关和重置时间提示一起删掉 |
| 全局项目 `local` 不能开自动化 | 任务 10 | 它的 `projects.workspace_path` 是 `NULL`（`server/database.mjs:750`），落到「请先为该项目设置工作区目录」分支。这是正确的：没有工作区就没有 agent 能干活的地方 |
| 模型下拉的内容取决于当前全局后端 | 任务 9/10 | `getAiChatCatalog` 是按当前后端拉的。切了后端之后，`projects.automation_options` 里存的 slug 可能不在新列表里 —— 规格 §5.5 要求「落回新后端的默认模型，不报错」，服务端已按此实现（A2 任务 11），前端表现是下拉回到「跟随后端默认」 |

## 手工验证（自动化测不到的，全部做完 10 个任务后走一遍）

前端测试是「读源码文本 + 断言字符串」，测不到任何渲染结果。下面这几条必须真开浏览器。

1. **拆分没有改变快捷对话的行为。** 这是任务 1–4 唯一的验收标准 —— 四个 commit 应该是纯搬家。右下角面板打开 → 切历史会话 → 发一条消息 → 看时间线滚动、思考步骤展开、附件缩略图、skill 引用高亮、`@` 提示菜单。任何一处与拆分前不同都是回归。

   ```bash
   cd /home/work/vdc/dashi-taskboard && npm run dev
   ```

2. **任务对话弹窗的视觉与遮罩层级**（规格 §9.3 第二条）。在一张有会话的卡片上点菜单进入：弹窗居中、宽 1100px、高 85vh、遮罩压住整个看板；此时再触发删除确认框（`.delete-backdrop` 的 z-index 是 80，弹窗遮罩是 90），确认删除框**盖在**弹窗之上而不是被埋掉。按 `Esc` 关弹窗。

3. **没有会话的卡片。** 点进去应该看到空态文案，不是空白弹窗、不是报错。

4. **跑动中只读。** 让一条任务跑起来（A2 的 scheduler 或手工在弹窗里发消息），确认输入框在 run 跑动期间是禁用的，run 结束后自动恢复可输入。

5. **「等你确认」里追问会把卡片拉回「处理中」**（规格 §7.5 路径 A，服务端逻辑在 A2 任务 13）。在 `in_review` 的任务弹窗里发一条修改意见，看看板上卡片是否从「等你确认」列移回「处理中」列。

6. **自动化配置真的落库了。** 开菜单改间隔和模型 → 关掉网页重开 → 值还在。再直接查库确认不是浏览器缓存：

   ```bash
   cd /home/work/vdc/dashi-taskboard && sqlite3 .data/taskboard.sqlite \
     "SELECT id, automation_options FROM projects;"
   ```

   库路径是 `<仓库根>/.data/taskboard.sqlite`（`server/app.mjs:1299-1301`，`CODEX_TASKBOARD_DATA_DIR` 可覆盖），不在 home 目录下。

7. **codex app 没在跑也能配自动化。** 这是整件事的目标（用户原话「项目脱离 codex app」）。确认 codex app 进程不存在的情况下，自动化菜单能开、能改、能存 —— 改造前这里会一直转圈等 host 响应。

## 自检结果

按 writing-plans 的三项自检走了一遍，发现并已就地修掉的问题记在这里。

**1. 规格覆盖度。** 规格里属于前端的条目逐条对位：

| 规格条目 | 落在哪 |
|---|---|
| §7.1 四条泳道，「等你回答」在处理中与等你确认之间 | 任务 7。**规格 §7.1 的「待核实」已核实，结论与规格的猜测不同**：`web/src/issueBoardStatuses.ts:3-8` 的 `MAIN_STATUSES` 早就是 `["todo","in_progress","blocked","in_review"]`，顺序也已经是规格要的那个；`blocked` 任务不是「不显示」，而是**有 blocked 任务时才显示这一列**（`App.tsx:1848-1851`）。所以泳道这件事只剩改文案，任务 7 因此从「加一列」缩成「改 6 处标签」 |
| §7.2 拆 `AiChat.tsx` | 任务 2/3/4，拆成 5 个文件（偏离表第 1 行说明为什么不是规格写的 3 个）|
| §7.4 有活跃 run 时只读 | 任务 6 |
| §7.5 路径 A 的前端入口 | 任务 5（弹窗里能发消息）+ 任务 6（跑动中不能）。状态回拉是 A2 任务 13 的服务端行为 |
| §7.6 三处新代码 | 任务 5 一次做完：弹窗外壳、卡片菜单路由、空态 |
| §8.3 自动化配置改走 HTTP，`quotaAware` 删掉，`model` 默认值不写死 | 任务 8/9/10 |
| §9.4 `chatSource` 的 46 处断言要跟着归位 | 任务 1 单列 —— 规格明确要求「这件事在实施计划里必须单列为一个任务」，照办 |

**2. 占位符扫描。** 全文没有「待定 / TODO / 后续实现 / 类似任务 N」。每个涉及代码改动的步骤都给了完整代码块或精确到行号的删除清单。两处需要执行者现场判断的地方都写了判断依据而不是留白：任务 2 步骤 2 给了 grep 归属规则来决定 10 个候选 helper 各自搬不搬；任务 10 步骤 4 要求先 grep `getAiChatCatalog` 是否已在 import 里再决定加不加。

**3. 类型一致性。** 逐个核对了跨任务复用的名字：

- `ConversationViewProps` 的 12 个字段（任务 3 定义）—— 任务 4 的 `QuickChatPanel`、任务 5 的 `TaskConversationModal`、任务 6 的 `readOnlyWhileRunning` 都按这份契约传参，没有出现第 13 个字段
- `selectedThreadRef` 保留原名（任务 3）—— 被 `test/ai-chat-ui.test.mjs:209` 钉住，改名会让一个不该失败的断言失败
- `AutomationOptions`（任务 9 在 `ProjectAutomationMenu.tsx` 导出）—— 任务 10 的 `saveProjectAutomation` 直接吃这个类型，不另造一份
- `ProjectAutomation`（任务 8 在 `types.ts` 定义）—— 任务 10 的 state 用它，与 `AutomationOptions` 是两个不同的东西：前者是接口返回的完整记录，后者是菜单编辑的 4 个字段。`updateProjectAutomation` 的入参写成 `Partial<ProjectAutomation>` 而不是 `AutomationOptions`，因为服务端做的是浅合并，接口能力比菜单实际用到的更宽

**修掉的三个问题：**

- 任务 9 步骤 1 原先写「替换 `:119-135`」，会连带删掉 4 个 `doesNotMatch` 守卫（没有取消/保存按钮、没有 `project-automation-actions`、没有 `onSave`）和 6 条强度标签断言。已收窄成只替换 `:123-125`，并写明 `:120-122` 与 `:126-135` 保留 —— 那些约束在新世界里依然成立，删掉是白白削弱测试。
- 任务 9 与任务 10 之间漏了一个 `strictFunctionTypes` 破口：任务 9 把 `onChange` 的参数类型放宽（`AutomationModel` → `string | null`），逆变会让 `App.tsx` 原来的 handler 不再匹配；同时新增的必填 `models` prop 也过不了 JSX 检查。考虑过反转 9/10 顺序（同样的问题镜像出现）和合并成一个任务（commit 太大），最后在任务 9 步骤 4 加了 6 行带注释的临时适配层，任务 10 步骤 5 删掉它。
- 任务 9 步骤 4 的适配层代码片段原先是我按印象写的（2 空格缩进、`automationProjectContext?.unavailableReason ?? null`），与 `App.tsx:2727-2734` 实际的 14 空格缩进和非可选访问不符。已改成逐字一致，避免执行者引入无关 diff。

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-08-14-taskboard-frontend.md`。

**必须在 A2（`2026-08-14-taskboard-scheduler.md`）全部做完之后再开始** —— 任务 8 依赖 A2 任务 11 建的 `GET/PATCH /api/projects/:id/automation`，任务 5/6 的手工验证依赖 A2 的 scheduler 能真把任务跑起来。

两种执行方式：

**1. 子代理驱动（推荐）** —— 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** —— 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

A1 是用内联方式一口气跑完 13 个任务的（13 个 commit `3312a92`…`24192a2`）。本计划任务 1–4 是连锁的重构（一个文件被反复搬动），内联执行更不容易在任务边界上丢上下文。

