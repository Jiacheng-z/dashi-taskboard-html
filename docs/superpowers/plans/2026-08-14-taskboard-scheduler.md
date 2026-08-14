# 本机任务调度器（scheduler）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 taskboard server 进程内跑一个调度器，把 `todo` 任务派给 agent 执行，每个任务一个独立会话，全程复用 `AiChatService`，不依赖 codex app。

**架构：** `server/task-scheduler.mjs` 定时轮询开启了自动化的项目 → 用乐观锁把 `todo` 认领成 `in_progress` → `aiChat.createThread()`（或对已绑定 thread 走 resume）→ `aiChat.startTurn(prompt)` → 通过 `aiChat.subscribe()` 等 run 进入终态 → 若 agent 没自己收尾则兜底置 `in_review` 并评论。`scripts/taskboard-automation-local.mjs` 退化成一个只打 `POST /api/local/ai/scheduler/tick` 的瘦客户端。

**技术栈：** Node ESM、node:test、better-sqlite3（经 `TaskboardDatabase`）、无新增依赖。

---

## 前置条件（A1 已落地，不要重做）

- `server/agent-backends/{index,codex,ducc,spawn-gate}.mjs` 已存在；adapter 契约 8 字段 `{id, resolveExecutable, needsCwd, spawnGapMs, buildArgs, buildPrompt, createNormalizer, discoverCatalog}`
- `settings` 表（`key/value/updated_at`）+ `database.getSetting(key)` / `database.setSetting(key, value)` 已存在
- `ai_chat_threads.backend` 列已存在；`aiChatThreadFromRow` 已返回 `backend`
- `GET/PATCH /api/local/ai/backend` 已存在
- `startTurn` 已实现「跨后端不 resume + 时间线插一条说明」

## 回归命令（每个任务的验证都用这一条，不要用 `npm test`）

```bash
cd /home/work/vdc/dashi-taskboard && node --test $(ls test/*.test.mjs | grep -vE "cloud-|inject|task-editor")
```

`npm test` 有 24 个**既有环境红灯**（cloud 那批要 D1/wrangler/miniflare；chromium 驱动的那批缺 dbus/UPower 直接 SIGSEGV）。**不要试图修它们。** 收窄版当前基线（A1 完成时）：`ℹ tests 337 / ℹ pass 337 / ℹ fail 0`。Node 默认 reporter 打的是 `ℹ pass`，不是 `# pass`。

## commit 约定

该仓库**没有配 user.name / user.email**，每次 commit 必须显式带上，不要改 global config：

```bash
git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" commit -m "..."
```

**绝不 stage 的既有脏东西**：已修改的 `package.json`（本计划任务 12 会改它，届时只 stage 自己那一处 diff 之外的内容不要动）、未跟踪的 `package.json.orig`、未跟踪的 `scripts/taskboard-automation-local.mjs`（任务 12 会把它变成跟踪文件）。

---

## 与规格的偏离（实施前已核实，务必先读）

规格 §8.4 列了 4 处「要删的 codex 耦合」。实查后其中两处**在线上是活的、有测试、前端在调**，照规格删会砍掉现有功能。本计划的处置：

| 规格条目 | 实查结论 | 本计划怎么做 |
|---|---|---|
| `app.mjs:1041-1091` 猜 workspace | `codexProjectRoot` / `readCodexProjectWorkspaces` 服务 `GET /api/device-workspaces`，前端 `listDeviceWorkspaces` 在用，`test/server.test.mjs` 有用例 | **只删** `latestThreadCwd` + `resolveProjectWorkspace` 的猜测链（任务 14），保留前两个函数 |
| `discoverSkills`/`discoverMcpServers` → 收进 adapter | `/api/workflow-capabilities` **有前端调用者**（`WorkflowBoard.tsx:517`），5 个测试 | 路由保留，实现改走 adapter（任务 15），adapter 新增第 9 个字段 `discoverMcpServers` |
| `findCodexSession`/`readCodexSessionState` → 删 | 路由 `/api/local/codex-thread-progress` 被 `web/src/App.tsx:1826` 每 2s 调一次，喂卡片进度条 | 路由与响应形状**原样保留**，实现改读 `ai_chat_threads.latestTodo` + `currentRun`（任务 16），前端零改动 |
| `CODEX_AGENT_ACTOR` 按 backend 取值 | `id: "codex-agent"` 是 wire 值：`parseAssigneeTarget`（`app.mjs:560`）校验它、前端发它、历史 task/comment 行的 `actor.id` 已经存了它 | **不做。** 按 backend 取值会让同一个逻辑 actor 在库里出现两种 id，assignee 过滤直接错，收益为零 |

另外规格 §8.4 没提但顺带核实过的一处：`resolveAiWorkspace`（`server/ai-chat-catalog.mjs:83`）也读 codex state 文件，但它已有 `projects.workspace_path` 兜底 —— 脱离 codex app 后只是那份 state 读不到、静默返回空，功能不受影响。**不动。**

第二处偏离与 scheduler 语义有关：规格 §8.2 给了全局 `scheduler_interval_ms`，§8.3 的前端组件又有 per-project `intervalMinutes`。本计划让两者都有实义 —— **全局值驱动轮询循环的节拍，per-project 值作为该项目两次认领之间的最小间隔**（内存里记 `lastClaimedAt`，重启即失效，重启后第一轮不受限）。否则 `intervalMinutes` 会是一个前端能改但后端不看的死配置。

---

## 文件结构

### 新建

| 文件 | 职责 |
|---|---|
| `shared/agent-task-prompt.mjs` | 把「一条任务 + 它的评论」渲染成给 agent 的 prompt，含两条硬约束与收尾指令。纯函数，不碰 DB |
| `server/task-scheduler.mjs` | `resolveSchedulerConfig()` + `TaskScheduler` 类：认领、建/续会话、等 turn、兜底、轮询循环 |
| `test/agent-task-prompt.test.mjs` | prompt 纯函数用例 |
| `test/task-scheduler.test.mjs` | scheduler 真集成（tmpdir 起真 DB + 假可执行文件 + `waitFor`） |

### 修改

| 文件 | 改什么 |
|---|---|
| `server/database.mjs` | 加 `countRunningAiChatRuns()`、`findAiChatThreadByIssueId()`；`projects` 加列 `automation_options`；加 `getProjectAutomation()`/`setProjectAutomation()` |
| `server/ai-chat.mjs` | `startTurn` 里：议题处于 `in_review` 时自动置回 `in_progress`（规格 §7.5 路径 A） |
| `server/agent-backends/codex.mjs` | 搬入 `discoverMcpServers`，adapter 加第 9 个字段 |
| `server/agent-backends/ducc.mjs` | adapter 加 `discoverMcpServers`（返回 `[]`，见任务 15 说明） |
| `server/app.mjs` | 实例化 scheduler + `close()` 里 `stop()`；新增 `POST /api/local/ai/scheduler/tick`、`GET/PATCH /api/projects/:id/automation`；任务 14/15/16 的三处解耦 |
| `shared/taskboard-automation.mjs` | 导出 `buildTaskctlCommand`（现在是模块私有），供 `agent-task-prompt.mjs` 复用 |
| `scripts/taskboard-automation-local.mjs` | 整文件重写成瘦 HTTP 客户端 |
| `package.json` | 加 `"automation:local"` script |
| `web/src/api.ts` + `web/src/App.tsx` | 任务 14 顺带：`listDevelopmentContexts` 去掉 `codexProjectId`/`codexThreadId` 两个参数 |
| `test/server.test.mjs` | 任务 10/11 往里加真 HTTP 用例（复用现成的 `startServer`/`request` 骨架）；任务 14/15 会让两个既有用例的前提失效，同任务内改掉。**不要动 `test/project-automation-settings.test.mjs`** —— 那个是读 `App.tsx`/`ProjectAutomationMenu.tsx` 源码文本的前端断言文件（里面还断言着 `model: "gpt-5.5"` 和 localStorage 的 `PROJECT_AUTOMATIONS_KEY`），归 B 计划改 |

---

## 任务 1：scheduler 需要的两个 DB 查询

**文件：**
- 修改：`server/database.mjs`（在 `getAiChatRun` 附近，用 Grep 定位 `getAiChatRun(id) {`）
- 测试：`test/settings-store.test.mjs`（A1 建的，继续往里加）

并发闸门直接查 `ai_chat_runs`，不另维护计数器 —— 唯一索引 `ai_chat_runs_one_active` 已经保证了每 thread 至多一个活跃 run（规格 §6.3）。

- [ ] **步骤 1：编写失败的测试**

`test/settings-store.test.mjs` 现在**没有任何共享 fixture**，每个 `test` 自己 `mkdtemp` + `new TaskboardDatabase`（读一遍文件开头就能看到）。跟着这个风格来，不要引入 fixture 函数。

先在文件顶部的 import 之后补两个本任务与任务 2 都要用的辅助物：

```js
const ACTOR = { type: "user", id: "settings-tester", name: "Settings Tester", avatarUrl: null };

function createTodo(database, projectId, title) {
  return database.createTask({
    projectId,
    title,
    description: "",
    status: "todo",
    priority: "none",
    labels: [],
    threadId: null,
    actor: ACTOR,
    assignee: ACTOR,
    workflowId: null,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
  });
}
```

`createTask` 的必填面比想象的宽（`server/database.mjs:1691-1723` 直接读 `input.labels` / `input.actor` / `input.assignee` / `input.workflowId` / `input.startDate` / `input.dueDate` / `input.recurrence`），少一个就报 `Cannot read properties of undefined`。这个辅助函数照抄 `test/task-project-move.test.mjs:36-54` 的字段集。

然后追加到文件末尾：

```js
test("scheduler reads running run count and the thread bound to an issue", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-settings-runs-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  try {
    database.createProject({ id: "p", name: "P", workspacePath: null });
    const task = createTodo(database, "p", "T");

    assert.equal(database.countRunningAiChatRuns(), 0);
    assert.equal(database.findAiChatThreadByIssueId(task.id), null);

    const thread = database.createAiChatThread({
      title: "T",
      origin: {
        projectId: "p",
        projectName: "P",
        workspacePath: "/tmp",
        issueId: task.id,
        issueIdentifier: task.identifier,
      },
      backend: "ducc",
      model: "m",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    assert.equal(database.findAiChatThreadByIssueId(task.id)?.id, thread.id);
    assert.equal(database.findAiChatThreadByIssueId(task.id)?.backend, "ducc");

    const run = database.createAiChatRun({ threadId: thread.id });
    assert.equal(database.countRunningAiChatRuns(), 1);
    database.updateAiChatRun(run.id, {
      status: "completed",
      exitCode: 0,
      error: null,
      finishedAt: new Date().toISOString(),
    });
    assert.equal(database.countRunningAiChatRuns(), 0);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/settings-store.test.mjs
```

预期：FAIL，`database.countRunningAiChatRuns is not a function`

- [ ] **步骤 3：编写实现**

在 `server/database.mjs` 的 `getAiChatRun(id) { ... }` 之后插入：

```js
  countRunningAiChatRuns() {
    return Number(this.database.prepare(`
      SELECT COUNT(*) AS running FROM ai_chat_runs WHERE status = 'running'
    `).get().running);
  }

  findAiChatThreadByIssueId(issueId) {
    const row = this.database.prepare(`
      SELECT * FROM ai_chat_threads
      WHERE origin_issue_id = ?
      ORDER BY updated_at DESC, id
      LIMIT 1
    `).get(issueId);
    return row ? this.#aiChatThreadWithCurrentRun(row) : null;
  }
```

`#aiChatThreadWithCurrentRun` 已在文件里（Grep `#aiChatThreadWithCurrentRun(row) {`），它会顺带填好 `currentRun` 和 `latestTodo`，scheduler 判「这个 thread 现在忙不忙」直接看 `currentRun`。

- [ ] **步骤 4：运行测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/settings-store.test.mjs
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
cd /home/work/vdc/dashi-taskboard \
  && git add server/database.mjs test/settings-store.test.mjs \
  && git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
     commit -m "feat: add running-run count and issue-bound thread lookup (任务 1/16)"
```

---

## 任务 2：`projects.automation_options` 列与读写方法

**文件：**
- 修改：`server/database.mjs`（ADD COLUMN 迁移段；`getProject` 附近加两个方法）
- 测试：`test/settings-store.test.mjs`

自动化配置从「host message + CDP」改成落库（规格 §8.3）。字段按规格删掉 `quotaAware`，`model` 不写死默认值。

- [ ] **步骤 1：编写失败的测试**

追加到 `test/settings-store.test.mjs`：

```js
test("project automation options default off and round-trip through the database", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-settings-automation-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  try {
    database.createProject({ id: "p", name: "P", workspacePath: null });

    assert.deepEqual(database.getProjectAutomation("p"), {
      enabledByUser: false,
      intervalMinutes: 5,
      model: null,
      reasoningEffort: null,
    });

    const saved = database.setProjectAutomation("p", {
      enabledByUser: true,
      intervalMinutes: 15,
      model: "claude-opus",
      reasoningEffort: "high",
    });
    assert.deepEqual(saved, {
      enabledByUser: true,
      intervalMinutes: 15,
      model: "claude-opus",
      reasoningEffort: "high",
    });
    assert.deepEqual(database.getProjectAutomation("p"), saved);
    assert.deepEqual(
      database.listProjectsWithAutomationEnabled().map((entry) => entry.projectId),
      ["p"],
    );

    // 浅合并：只带一个字段不应该把其他字段冲掉
    assert.equal(database.setProjectAutomation("p", { intervalMinutes: 30 }).model, "claude-opus");

    database.setProjectAutomation("p", { enabledByUser: false });
    assert.deepEqual(database.listProjectsWithAutomationEnabled(), []);

    assert.throws(
      () => database.getProjectAutomation("missing"),
      (error) => error.code === "PROJECT_NOT_FOUND",
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/settings-store.test.mjs
```

预期：FAIL，`database.getProjectAutomation is not a function`

- [ ] **步骤 3：ADD COLUMN 迁移**

Grep `PRAGMA table_info(projects)` 定位既有的 projects 迁移段（A1 之后大约在 `server/database.mjs:536`），在它的 `workspace_path` 判断之后追加：

```js
    if (!projectColumns.some((column) => column.name === "automation_options")) {
      this.database.exec("ALTER TABLE projects ADD COLUMN automation_options TEXT");
    }
```

注意 `projectColumns` 是同一次 `PRAGMA` 的结果，直接复用，不要再查一次。

- [ ] **步骤 4：编写读写方法**

在 `server/database.mjs` 的 `getProject(id) { ... }` 之前插入模块级默认值与三个方法：

```js
const DEFAULT_PROJECT_AUTOMATION = {
  enabledByUser: false,
  intervalMinutes: 5,
  // model / reasoningEffort 为 null 表示「跟随后端 catalog 的默认值」，
  // 不写死 codex 时代的 "gpt-5.5"（规格 §8.3）
  model: null,
  reasoningEffort: null,
};

function projectAutomationFromJson(raw) {
  let parsed = null;
  try {
    parsed = raw === null || raw === undefined ? null : JSON.parse(raw);
  } catch {}
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...DEFAULT_PROJECT_AUTOMATION };
  }
  const intervalMinutes = Number(parsed.intervalMinutes);
  return {
    enabledByUser: parsed.enabledByUser === true,
    intervalMinutes: Number.isInteger(intervalMinutes) && intervalMinutes > 0
      ? intervalMinutes
      : DEFAULT_PROJECT_AUTOMATION.intervalMinutes,
    model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : null,
    reasoningEffort: typeof parsed.reasoningEffort === "string" && parsed.reasoningEffort.trim()
      ? parsed.reasoningEffort.trim()
      : null,
  };
}
```

`DEFAULT_PROJECT_AUTOMATION` 放在模块级是刻意的：任务 11 的路由校验和任务 4 的 scheduler 都要引用它，属于多处共用的常量。同时在文件的 `export` 区把它导出：

```js
export { DEFAULT_PROJECT_AUTOMATION };
```

类方法（放在 `getProject` 之前）：

```js
  getProjectAutomation(projectId) {
    const row = this.database
      .prepare("SELECT automation_options FROM projects WHERE id = ?").get(projectId);
    if (!row) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    return projectAutomationFromJson(row.automation_options);
  }

  setProjectAutomation(projectId, changes) {
    const current = this.getProjectAutomation(projectId);
    const next = { ...current, ...changes };
    const result = this.database.prepare(`
      UPDATE projects SET automation_options = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(next), now(), projectId);
    if (result.changes !== 1) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    return this.getProjectAutomation(projectId);
  }

  listProjectsWithAutomationEnabled() {
    return this.database.prepare(`
      SELECT id, name, workspace_path, automation_options FROM projects
      WHERE automation_options IS NOT NULL
      ORDER BY id
    `).all()
      .map((row) => ({
        projectId: row.id,
        projectName: row.name,
        workspacePath: row.workspace_path,
        automation: projectAutomationFromJson(row.automation_options),
      }))
      .filter((entry) => entry.automation.enabledByUser);
  }
```

`setProjectAutomation` 走**浅合并**，这样任务 11 的 PATCH 可以只带一个字段。

- [ ] **步骤 5：运行测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/settings-store.test.mjs
```

预期：PASS

- [ ] **步骤 6：跑一遍全量回归**

```bash
cd /home/work/vdc/dashi-taskboard && node --test $(ls test/*.test.mjs | grep -vE "cloud-|inject|task-editor")
```

预期：`ℹ fail 0`。新增列会进 `getProject` 的 `SELECT` 列表吗？**不会** —— `getProject` 是显式列名，没写 `automation_options`，`projectFromRow` 也不读它。自动化配置只经上面三个方法出入，不进 `/api/projects` 的响应体，前端零影响。

- [ ] **步骤 7：Commit**

```bash
cd /home/work/vdc/dashi-taskboard \
  && git add server/database.mjs test/settings-store.test.mjs \
  && git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
     commit -m "feat: persist per-project automation options (任务 2/16)"
```

## 任务 3：把一条任务渲染成 agent prompt

**文件：**
- 创建：`shared/agent-task-prompt.mjs`
- 修改：`shared/taskboard-automation.mjs:78`（`function buildTaskctlCommand` 前面加 `export`）
- 测试：创建 `test/agent-task-prompt.test.mjs`

纯函数，不碰 DB、不读 `process.env`（`taskctlCommand` 由调用方算好传进来），这样测试不需要任何 fixture。

**字段名先对齐（别按直觉写）：** `taskFromRow`（`server/database.mjs:163`）给的是 `identifier / title / description / status / version / priority / labels`；`commentFromRow`（`:227`）给的是**扁平的** `authorName`，**不是** `author.name`。

- [ ] **步骤 1：编写失败的测试**

创建 `test/agent-task-prompt.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentTaskPrompt } from "../shared/agent-task-prompt.mjs";
import { buildTaskctlCommand } from "../shared/taskboard-automation.mjs";

const TASKCTL = "'/usr/bin/node' '/repo/cli/taskctl.mjs'";

function render(overrides = {}) {
  return buildAgentTaskPrompt({
    task: {
      id: "t1",
      identifier: "LOCAL-3",
      title: "修一个 bug",
      description: "点击保存没反应",
      status: "in_progress",
      version: 4,
      ...overrides.task,
    },
    comments: overrides.comments ?? [
      { body: "先看 handler", authorName: "我", createdAt: "2026-08-14T01:00:00.000Z" },
      { body: "复现步骤见附件", authorName: "我", createdAt: "2026-08-14T02:00:00.000Z" },
    ],
    project: { id: "p", name: "P", workspacePath: "/ws" },
    skillPath: "/repo/skills/manage-taskboard/SKILL.md",
    taskctlCommand: TASKCTL,
  });
}
```

```js
test("prompt carries identifier, title, description and every comment", () => {
  const prompt = render();
  assert.match(prompt, /LOCAL-3/);
  assert.match(prompt, /修一个 bug/);
  assert.match(prompt, /点击保存没反应/);
  assert.match(prompt, /先看 handler/);
  assert.match(prompt, /复现步骤见附件/);
  assert.match(prompt, /\/repo\/skills\/manage-taskboard\/SKILL\.md/);
  assert.match(prompt, /\/ws/);
});

test("prompt spells out the wrap-up sequence and never allows done", () => {
  const prompt = render();
  assert.match(prompt, /comment add LOCAL-3/);
  assert.match(prompt, /issue get LOCAL-3/);
  assert.match(prompt, /issue move LOCAL-3 --status in_review --if-version/);
  assert.doesNotMatch(prompt, /--status done/);
  // 状态已经由 scheduler 认领好了，不要让 agent 再移一次
  assert.doesNotMatch(prompt, /--status in_progress/);
});

test("prompt states the two hard constraints", () => {
  const prompt = render();
  assert.match(prompt, /禁止任何 git 写操作/);
  for (const forbidden of ["commit", "add", "stash", "checkout", "reset", "rebase", "merge", "push"]) {
    assert.match(prompt, new RegExp(`git ${forbidden}`));
  }
  assert.match(prompt, /git status/);
  assert.match(prompt, /不许从 `git diff` 推导/);
});

test("prompt tolerates an empty description and no comments", () => {
  const prompt = render({ task: { description: null }, comments: [] });
  assert.match(prompt, /（无描述）/);
  assert.match(prompt, /（暂无评论）/);
  assert.doesNotMatch(prompt, /undefined|null/);
});

test("buildTaskctlCommand is exported and points at cli/taskctl.mjs", () => {
  const command = buildTaskctlCommand({ skillPath: "/repo/skills/manage-taskboard/SKILL.md" });
  assert.match(command, /cli\/taskctl\.mjs/);
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/agent-task-prompt.test.mjs
```

预期：FAIL，`Cannot find module '.../shared/agent-task-prompt.mjs'`

- [ ] **步骤 3：导出 `buildTaskctlCommand`**

`shared/taskboard-automation.mjs:78`，只加一个关键字：

```js
export function buildTaskctlCommand(request) {
```

它内部读 `process.env.CODEX_TASKBOARD_RUNTIME_FILE`，所以留在这个文件里、由 scheduler 调用，不下沉到 prompt 模块。

- [ ] **步骤 4：编写 `shared/agent-task-prompt.mjs`**

```js
function renderComments(comments) {
  if (!Array.isArray(comments) || comments.length === 0) return "（暂无评论）";
  return comments
    .map((comment, index) => {
      const who = comment.authorName?.trim() || "未署名";
      const when = comment.createdAt ?? "";
      const body = comment.body?.trim() || "（空评论）";
      return `${index + 1}. [${who} ${when}]\n${body}`;
    })
    .join("\n\n");
}

export function buildAgentTaskPrompt({ task, comments, project, skillPath, taskctlCommand }) {
  const id = task.identifier;
  return [
    `[$manage-taskboard](${skillPath}) e-taskboard`,
    `你正在处理任务面板「${project.name}」（项目 ID：${project.id}）里的议题 ${id}。`,
    `项目目录：${project.workspacePath ?? "（未配置，按当前工作目录处理）"}`,
    `本轮所有 taskctl 操作都使用完整命令前缀 ${taskctlCommand}，不要使用 PATH 中的 taskctl。`,
    "",
    `## 议题 ${id}：${task.title}`,
    task.description?.trim() || "（无描述）",
    "",
    "## 已有评论（含可能的返工要求，按时间正序）",
    renderComments(comments),
  ].concat(renderRules(id, taskctlCommand)).join("\n");
}
```

`renderRules` 就是规格 §3 那两条硬约束 + §6.2 的收尾分工，放在同一个文件的 `renderComments` 之后：

```js
function renderRules(id, taskctlCommand) {
  return [
    "",
    "## 硬约束（违反即视为本次执行失败）",
    "1. **禁止任何 git 写操作**：不得执行 git commit、git add、git stash、git checkout、git reset、git rebase、git merge、git push，也不得用其他命令间接达成同样效果。"
      + "使用者的工作区长期是脏的，一次 `git add -A` 会把他没写完的改动一起提交。只读的 git status、git diff、git log 可以用来看现状。",
    "2. **「改了什么」必须你自己逐条记录，不许从 `git diff` 推导**：这个目录里同时混着使用者的改动和别的 agent 的改动，"
      + "`git diff` 的内容归不到你头上。边做边记下你实际编辑过的文件与改动点，收尾时照记录写。",
    "",
    "## 收尾（必须做，否则任务会被 scheduler 判为未完成）",
    `1. 写评论：${taskctlCommand} comment add ${id} --body "<关键改动、验证方式与结果、剩余风险>"`,
    `2. 读最新版本号：${taskctlCommand} issue get ${id} --json`,
    `3. 用该版本号移状态：${taskctlCommand} issue move ${id} --status in_review --if-version <version>`,
    "",
    "议题已经由 scheduler 认领并置为 in_progress，你不需要也不应该再改成 in_progress。",
    "只能移到 in_review，不要直接标记为 done —— done 由使用者确认后自己点。",
    "如果你判断这件事做不了或需要使用者补充信息，同样走上面三步：把原因写进评论，再移到 in_review。",
  ];
}
```

- [ ] **步骤 5：运行测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/agent-task-prompt.test.mjs
```

预期：PASS，5 个用例全绿。

- [ ] **步骤 6：Commit**

```bash
cd /home/work/vdc/dashi-taskboard \
  && git add shared/agent-task-prompt.mjs shared/taskboard-automation.mjs test/agent-task-prompt.test.mjs \
  && git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
     commit -m "feat: render a taskboard issue into an agent prompt (任务 3/16)"
```

---

## 任务 4：scheduler 配置解析 + 测试 fixture

**文件：**
- 创建：`server/task-scheduler.mjs`
- 测试：创建 `test/task-scheduler.test.mjs`

这个任务同时把**任务 4–9 共用的 fixture** 建好，后面几个任务只往同一个文件追加 `test(...)`，不再重复搭环境。

**又一处可以省掉的活（实查后确认，写实现前先读）：** 规格 §6 的流程图里「有绑定 thread 且 backend 不同 → 新建 + 时间线注明」这一支，**A1 已经在 `server/ai-chat.mjs:293-299` 和 `:331-342` 实现了** —— `startTurn` 自己会比较 `thread.backend` 与当前后端，不同就清掉 `codexThreadId` 走新会话分支，并插一条 `role: "activity"` 的说明事件。所以 scheduler 侧的分支只剩两个：**有绑定 thread 就直接 `startTurn` 它（续不续由 `startTurn` 决定），没有就 `createThread`**。任务 6 按这个写，不要再实现一遍。

- [ ] **步骤 1：编写 fixture 与配置用例**

创建 `test/task-scheduler.test.mjs`：

```js
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { AiChatService } from "../server/ai-chat.mjs";
import { TaskScheduler, resolveSchedulerConfig } from "../server/task-scheduler.mjs";

async function waitFor(predicate, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

const ACTOR = { type: "user", id: "scheduler-tester", name: "Scheduler Tester", avatarUrl: null };
```

同一个文件里紧接着放 fixture。假可执行文件比 `test/ai-chat-runner.test.mjs` 那个精简很多，只要 `debug models` 和 `exec` 两个分支：

```js
async function createFixture({ concurrency, intervalMs, holdMs } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-scheduler-"));
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath);
  const workspace = await realpath(workspacePath);
  const capturePath = path.join(directory, "capture.jsonl");
  const executable = path.join(directory, "fake-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "debug" && args[1] === "models") {
  process.stdout.write(JSON.stringify({models:[{
    slug:"gpt-real", display_name:"GPT Real", description:"fixture",
    default_reasoning_level:"medium",
    supported_reasoning_levels:[{effort:"low"},{effort:"medium"},{effort:"high"}]
  }]}));
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "list") { process.stdout.write("[]"); process.exit(0); }
if (args[0] === "app-server") { process.stdin.resume(); }
else if (args[0] === "exec") {
  process.stdin.setEncoding("utf8");
  let prompt = "";
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    appendFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify({args,prompt}) + "\\n");
    const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    if (!args.includes("resume")) emit({type:"thread.started",thread_id:"codex-" + Date.now() + "-" + Math.random()});
    emit({type:"turn.started"});
    const hold = Number(process.env.FAKE_HOLD_MS ?? 0);
    const finish = () => {
      if (prompt.includes("EXIT_NONZERO")) { process.stderr.write("boom: fake failure tail\\n"); process.exit(9); }
      emit({type:"item.completed",item:{type:"agent_message",text:"done"}});
      emit({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}});
    };
    if (hold > 0) setTimeout(finish, hold); else finish();
  });
}
`);
  await chmod(executable, 0o755);
```

同一个函数继续，起真 DB + 真 `AiChatService` + 真 `TaskScheduler`：

```js
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "project", name: "Project", workspacePath: workspace });
  if (concurrency !== undefined) database.setSetting("scheduler_concurrency", String(concurrency));
  if (intervalMs !== undefined) database.setSetting("scheduler_interval_ms", String(intervalMs));

  const processEnv = {
    ...process.env,
    FAKE_CAPTURE_PATH: capturePath,
    // holdMs 让假可执行文件在退出前挂住，用来构造「多个 run 同时 running」的局面（任务 9 要用）
    ...(holdMs ? { FAKE_HOLD_MS: String(holdMs) } : {}),
  };
  const aiChat = new AiChatService({
    database,
    agentBackendId: "codex",
    codexExecutable: executable,
    codexStatePath: path.join(directory, "missing-codex-state.json"),
    manageTaskboardSkillPath: path.join(directory, "skills/manage-taskboard/SKILL.md"),
    processEnv,
    killGraceMs: 50,
  });
  const scheduler = new TaskScheduler({
    database,
    aiChat,
    manageTaskboardSkillPath: path.join(directory, "skills/manage-taskboard/SKILL.md"),
    processEnv,
  });

  return {
    aiChat, capturePath, database, directory, executable, processEnv, scheduler, workspace,
    createTodo(title) {
      return database.createTask({
        projectId: "project",
        title,
        description: "",
        status: "todo",
        priority: "none",
        labels: [],
        threadId: null,
        actor: ACTOR,
        assignee: ACTOR,
        workflowId: null,
        developmentContext: null,
        startDate: null,
        dueDate: null,
        recurrence: null,
      });
    },
    async captured() {
      try {
        return (await readFile(capturePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch { return []; }
    },
    async close() {
      scheduler.stop();
      await aiChat.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
```

`codexStatePath` 指向一个不存在的文件是刻意的：默认的 `resolveContext` 走 `resolveAiWorkspace`，读不到 codex state 就回落 `projects.workspace_path`，正好验证脱离 codex app 后的路径。

- [ ] **步骤 2：编写配置解析用例**

追加到 `test/task-scheduler.test.mjs`：

```js
test("scheduler config falls back to defaults, then settings, then env", async () => {
  const fixture = await createFixture();
  try {
    const { database } = fixture;
    assert.deepEqual(resolveSchedulerConfig({ database, processEnv: {} }), {
      concurrency: 2,
      intervalMs: 300_000,
    });

    database.setSetting("scheduler_concurrency", "4");
    database.setSetting("scheduler_interval_ms", "60000");
    assert.deepEqual(resolveSchedulerConfig({ database, processEnv: {} }), {
      concurrency: 4,
      intervalMs: 60_000,
    });

    // 环境变量单次覆盖，优先于 settings，且不写库
    assert.equal(
      resolveSchedulerConfig({ database, processEnv: { TASKBOARD_CONCURRENCY: "1" } }).concurrency,
      1,
    );
    assert.equal(database.getSetting("scheduler_concurrency"), "4");

    // 垃圾值一律落回默认，不抛
    database.setSetting("scheduler_concurrency", "not-a-number");
    database.setSetting("scheduler_interval_ms", "-5");
    assert.deepEqual(resolveSchedulerConfig({ database, processEnv: {} }), {
      concurrency: 2,
      intervalMs: 300_000,
    });
  } finally {
    await fixture.close();
  }
});
```

- [ ] **步骤 3：运行测试验证失败**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/task-scheduler.test.mjs
```

预期：FAIL，`Cannot find module '.../server/task-scheduler.mjs'`

- [ ] **步骤 4：创建 `server/task-scheduler.mjs`**

先只写配置解析与一个空壳类，后续任务往里填方法：

```js
import { buildAgentTaskPrompt } from "../shared/agent-task-prompt.mjs";
import { buildTaskctlCommand } from "../shared/taskboard-automation.mjs";

export const SCHEDULER_ACTOR = {
  type: "agent",
  // 与 app.mjs 的 CODEX_AGENT_ACTOR 保持同一个 wire 值：assignee 过滤、
  // 历史评论的 actor.id 都认这个字符串，换 backend 也不能换它（见「与规格的偏离」）
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_INTERVAL_MS = 300_000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveSchedulerConfig({ database, processEnv }) {
  const env = processEnv ?? {};
  return {
    concurrency: positiveInteger(
      env.TASKBOARD_CONCURRENCY ?? database.getSetting("scheduler_concurrency"),
      DEFAULT_CONCURRENCY,
    ),
    intervalMs: positiveInteger(
      env.TASKBOARD_INTERVAL_MS ?? database.getSetting("scheduler_interval_ms"),
      DEFAULT_INTERVAL_MS,
    ),
  };
}

export class TaskScheduler {
  constructor(options) {
    this.database = options.database;
    this.aiChat = options.aiChat;
    this.manageTaskboardSkillPath = options.manageTaskboardSkillPath;
    this.processEnv = options.processEnv ?? process.env;
    // key = projectId，value = 上次认领的毫秒时间戳。只在内存里，重启即失效，
    // 重启后第一轮不受 per-project intervalMinutes 限制（见「与规格的偏离」第二处）
    this.lastClaimedAt = new Map();
    this.timer = null;
    // 已认领但 ai_chat_runs 行还没建出来的任务 id。并发闸门要把这批算进去，
    // 否则一轮里连开 N 个 startTurn 时 COUNT(*) 还是 0，上限形同虚设（任务 9）
    this.pending = new Set();
  }

  config() {
    return resolveSchedulerConfig({ database: this.database, processEnv: this.processEnv });
  }
}
```

注意 `TASKBOARD_INTERVAL_MS` 是顺手加的（原脚本 `scripts/taskboard-automation-local.mjs:8` 就认这个名字，任务 12 重写后仍然认，保持一致），规格 §8.2 只点了 `TASKBOARD_CONCURRENCY`。

- [ ] **步骤 5：运行测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/task-scheduler.test.mjs
```

预期：PASS

- [ ] **步骤 6：Commit**

```bash
cd /home/work/vdc/dashi-taskboard \
  && git add server/task-scheduler.mjs test/task-scheduler.test.mjs \
  && git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
     commit -m "feat: resolve scheduler config from settings and env (任务 4/16)"
```

---

## 任务 5：认领任务（乐观锁，冲突即放弃）

**文件：**
- 修改：`server/task-scheduler.mjs`（往任务 4 建的类里加 `claimTask`）
- 测试：`test/task-scheduler.test.mjs`（追加）

规格 §6.2：scheduler 只负责 `todo → in_progress`，带乐观锁；版本冲突就放弃这一条，不重试。

`moveTask(id, version, status, sortOrder, threadId, actor)`（`server/database.mjs:1865-1910`）：
- `sortOrder` 传 `undefined` 会自动算（换状态时取目标列 `MIN(sort_order) - 1000`），**不要传 `null`**——`null` 会被当成真实排序值写进去
- 版本不符时 `#requireVersion` 在 UPDATE 之前就抛 `ApiError(409, "VERSION_CONFLICT", …, { expectedVersion, actualVersion })`（`server/database.mjs:2470-2477`）；`ApiError` 有 `.status` / `.code` / `.details` 三个属性（`server/database.mjs:10-18`）
- `threadId` 传 `null` 表示不改这一列（SQL 里是 `COALESCE(?, thread_id)`）；thread 绑定由任务 6 通过 `ai_chat_threads.origin_issue_id` 完成，不写 `tasks.thread_id`

- [ ] **步骤 1：编写失败的测试**

追加到 `test/task-scheduler.test.mjs`：

```js
test("claimTask 把 todo 推到 in_progress，版本冲突时返回 null", async () => {
  const fixture = await createFixture();
  try {
    const task = fixture.createTodo("认领我");
    const claimed = fixture.scheduler.claimTask(task);
    assert.equal(claimed.status, "in_progress");
    assert.equal(claimed.version, task.version + 1);

    // 拿过期的 version 再认领一次：模拟另一个 scheduler 实例已抢走
    assert.equal(fixture.scheduler.claimTask(task), null);
    assert.equal(fixture.database.getTask(task.id).status, "in_progress");
    assert.equal(fixture.database.getTask(task.id).version, task.version + 1);
  } finally {
    await fixture.close();
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/task-scheduler.test.mjs
```

预期：FAIL，报错 `fixture.scheduler.claimTask is not a function`

- [ ] **步骤 3：编写实现**

在 `TaskScheduler` 的 `config()` 之后加：

```js
  claimTask(task) {
    try {
      return this.database.moveTask(
        task.id,
        task.version,
        "in_progress",
        undefined,
        null,
        SCHEDULER_ACTOR,
      );
    } catch (error) {
      // 另一个 scheduler 实例（或用户手动拖动）先改了这条 → 放弃，不重试
      if (error?.code === "VERSION_CONFLICT") return null;
      throw error;
    }
  }
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/task-scheduler.test.mjs
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
cd /home/work/vdc/dashi-taskboard \
  && git add server/task-scheduler.mjs test/task-scheduler.test.mjs \
  && git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
     commit -m "feat: claim todo tasks with optimistic locking (任务 5/16)"
```

---

## 任务 6：每任务一个独立会话（已绑定则复用）

**文件：**
- 修改：`server/task-scheduler.mjs`
- 测试：`test/task-scheduler.test.mjs`（追加）

这是规格 §6.1 点的核心 bug 修复：原脚本 `scripts/taskboard-automation-local.mjs:12` 把 `crypto.randomUUID()` 写在模块顶层，所有任务共用一个会话 id。改成每条任务各自走一次 `createThread()` 之后，这个 bug 从位置上就不存在了。

**注意（避免重复实现）：** 规格 §6 流程图里「有绑定 thread 但 backend 不同 → 新建 + 时间线注明旧对话不可续」这一支，**A1 已经在 `startTurn` 里做完了**（`server/ai-chat.mjs:292-299` 清掉 `codexThreadId` 并改写 `backend` 列，`:331-342` 插入 `role:"activity"` 的说明事件）。所以 scheduler 这里只有两支：绑定过 thread ⇒ 直接拿来 `startTurn`；没绑定过 ⇒ `createThread`。**不要再写一遍 backend 比较。**

`createThread` 的两个坑（`server/ai-chat.mjs:150-158`）：
- `if (input.model !== undefined) this.#requireKnownModel(catalog, input.model)` —— `null !== undefined` 成立，所以传 `model: null` 会抛 `INVALID_MODEL`。automation 配置里 `model` 默认就是 `null`，**必须用条件展开，不能直接透传**
- `reasoningEffort` 那行是 `input.reasoningEffort ?? model.defaultReasoningEffort`，`null` 会被 `??` 吃掉，本来安全；为了对称也一起条件展开

`createThread({ projectId, issueId })` 会经 `resolveContext` 校验 issue 属于该项目且未归档（`server/ai-chat.mjs:56-66`），并把 `origin.issueId` / `origin.issueIdentifier` 写进 thread，前端 `web/src/taskConversations.ts:65` 靠这个字段过滤。

- [ ] **步骤 1：编写失败的测试**

```js
test("每条任务各自建 thread，已绑定的任务复用原 thread", async () => {
  const fixture = await createFixture();
  try {
    const automation = { model: null, reasoningEffort: null };
    const first = fixture.createTodo("任务甲");
    const second = fixture.createTodo("任务乙");

    const threadA = await fixture.scheduler.ensureThread(first, automation);
    const threadB = await fixture.scheduler.ensureThread(second, automation);
    assert.notEqual(threadA.id, threadB.id);
    assert.equal(threadA.origin.issueId, first.id);
    assert.equal(threadB.origin.issueId, second.id);

    // 同一条任务再来一轮（规格 §7.5 路径 B：人手拖回 todo）→ 复用而非新建
    const again = await fixture.scheduler.ensureThread(first, automation);
    assert.equal(again.id, threadA.id);
    assert.equal(fixture.database.listAiChatThreads().length, 2);
  } finally {
    await fixture.close();
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/task-scheduler.test.mjs
```

预期：FAIL，报错 `fixture.scheduler.ensureThread is not a function`

- [ ] **步骤 3：编写实现**

在 `claimTask` 之后加：

```js
  async ensureThread(task, automation) {
    const existing = this.database.findAiChatThreadByIssueId(task.id);
    // 跨 backend 不能 resume 的处理在 startTurn 里（server/ai-chat.mjs:292-299），此处不重复
    if (existing) return existing;
    return this.aiChat.createThread({
      projectId: task.projectId,
      issueId: task.id,
      // automation 里这两项默认是 null，null 会被 #requireKnownModel 判为非法，必须条件展开
      ...(automation.model ? { model: automation.model } : {}),
      ...(automation.reasoningEffort ? { reasoningEffort: automation.reasoningEffort } : {}),
    });
  }
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/task-scheduler.test.mjs
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
cd /home/work/vdc/dashi-taskboard \
  && git add server/task-scheduler.mjs test/task-scheduler.test.mjs \
  && git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
     commit -m "feat: give each task its own agent thread (任务 6/16)"
```

---

## 任务 7：跑一轮任务并等 run 落地

**文件：**
- 修改：`server/task-scheduler.mjs`
- 测试：`test/task-scheduler.test.mjs`（追加）

这是「scheduler 复用 `AiChatService`」的落点（规格 §4）：不自己 spawn，走 `startTurn`，于是 `ai_chat_events` 行、SSE 推送、网页时间线全部免费得到。

**等 run 结束用 `subscribe`，不要轮询、也不要碰 `this.completions`**（那是私有字段）。`#finishRun`（`server/ai-chat.mjs:629-636`）在 run 落到终态时 `updateAiChatRun` 然后 `#emit(threadId, { type: "ai.run", run: updated })`。终态三个值：`completed` / `failed` / `interrupted`。

有一个真实竞态要处理：`startTurn` 返回的是**还在 running 的 run 行**，但假可执行文件可能在我们订阅之前就退出了。所以订阅之后必须立刻补查一次 `getRun(runId)`，否则测试会挂到超时。

- [ ] **步骤 1：编写失败的测试**

```js
test("runTask 把议题正文与评论送进 prompt，并等到 run 落终态", async () => {
  const fixture = await createFixture();
  try {
    const task = fixture.createTodo("修一个 bug");
    fixture.database.createComment(task.id, {
      body: "顺手把日志也补上",
      threadId: null,
      actor: ACTOR,
    });
    const project = {
      projectId: "project",
      projectName: "Project",
      workspacePath: fixture.workspace,
      automation: { model: null, reasoningEffort: null },
    };

    const run = await fixture.scheduler.runTask(task, project);
    assert.equal(run.status, "completed");

    const [capture] = await fixture.captured();
    assert.equal(capture.prompt.includes(task.identifier), true);
    assert.equal(capture.prompt.includes("修一个 bug"), true);
    assert.equal(capture.prompt.includes("顺手把日志也补上"), true);
    assert.equal(capture.prompt.includes("禁止任何 git 写操作"), true);
    assert.equal(capture.prompt.includes("cli/taskctl.mjs"), true);
  } finally {
    await fixture.close();
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/task-scheduler.test.mjs
```

预期：FAIL，报错 `fixture.scheduler.runTask is not a function`

- [ ] **步骤 3：编写实现**

在 `ensureThread` 之后加：

```js
  waitForRun(threadId, runId) {
    return new Promise((resolve) => {
      const settle = (run) => {
        unsubscribe();
        resolve(run);
      };
      const unsubscribe = this.aiChat.subscribe(threadId, (event) => {
        if (event.type !== "ai.run") return;
        if (event.run.id !== runId || event.run.status === "running") return;
        settle(event.run);
      });
      // 进程可能在订阅之前就退出了（#finishRun 已经 emit 完），补查一次兜住这个竞态
      const current = this.aiChat.getRun(runId);
      if (current.status !== "running") settle(current);
    });
  }

  async runTask(task, project, onStarted) {
    const thread = await this.ensureThread(task, project.automation);
    const prompt = buildAgentTaskPrompt({
      task,
      comments: this.database.listComments(task.id),
      project: {
        id: project.projectId,
        name: project.projectName,
        workspacePath: project.workspacePath,
      },
      skillPath: this.manageTaskboardSkillPath,
      taskctlCommand: buildTaskctlCommand({ skillPath: this.manageTaskboardSkillPath }),
    });
    const run = await this.aiChat.startTurn(thread.id, { message: prompt });
    // run 行已经落库，从这一刻起并发计数交给 countRunningAiChatRuns()（任务 9 传这个回调）
    onStarted?.();
    return this.waitForRun(thread.id, run.id);
  }
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/task-scheduler.test.mjs
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
cd /home/work/vdc/dashi-taskboard \
  && git add server/task-scheduler.mjs test/task-scheduler.test.mjs \
  && git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
     commit -m "feat: run a claimed task through AiChatService (任务 7/16)"
```

---

## 任务 8：兜底收尾（agent 没收尾就落 in_review）

**文件：**
- 修改：`server/task-scheduler.mjs`
- 测试：`test/task-scheduler.test.mjs`（追加）

规格 §6.2：`in_review` 在服务端**没有任何流转校验**（`server/database.mjs` 只有管取值范围的 CHECK 约束），全靠 prompt 约定。agent 崩了 / 超时 / 自己判断做不了但没说，任务就永远卡在 `in_progress` 挡住并发名额。所以进程退出后必须回查一次。

三条硬规则，不要自作主张改：
- **兜底不落 `blocked`**（那一列留给阶段二的 askQuestion）
- **兜底不落回 `todo`** —— 会被下一轮轮询再捞起来无限重跑烧额度，且失败原因每轮被覆盖
- 评论必须以 `⚠️ 执行未完成` 开头，这是人工和后续脚本识别兜底评论的标记

`createComment(taskId, { body, threadId, actor })`（`server/database.mjs:2119-2137`）；评论作者字段在读回来时是**扁平的** `authorName`（`commentFromRow`，`server/database.mjs:227-242`）。

- [ ] **步骤 1：编写失败的测试**

```js
test("agent 没收尾时兜底评论并落 in_review；已收尾则不插手", async () => {
  const fixture = await createFixture();
  const project = {
    projectId: "project",
    projectName: "Project",
    workspacePath: fixture.workspace,
    automation: { model: null, reasoningEffort: null },
  };
  try {
    // 情形一：假可执行文件 exit 9，任务仍停在 in_progress
    const failing = fixture.scheduler.claimTask(fixture.createTodo("EXIT_NONZERO 故意失败"));
    const failedRun = await fixture.scheduler.runTask(failing, project);
    assert.equal(failedRun.status, "failed");
    const finalized = fixture.scheduler.finalize(failing, failedRun);
    assert.equal(finalized.status, "in_review");
    const comment = fixture.database.listComments(failing.id).at(-1);
    assert.equal(comment.body.startsWith("⚠️ 执行未完成"), true);
    assert.equal(comment.body.includes("9"), true);
    assert.equal(comment.authorId, "codex-agent");

    // 情形二：agent 自己已经置了 in_review → finalize 不加评论、不改状态
    const done = fixture.scheduler.claimTask(fixture.createTodo("正常完成"));
    const okRun = await fixture.scheduler.runTask(done, project);
    const moved = fixture.database.moveTask(
      done.id, done.version, "in_review", undefined, null, ACTOR,
    );
    const after = fixture.scheduler.finalize(moved, okRun);
    assert.equal(after.status, "in_review");
    assert.equal(fixture.database.listComments(done.id).length, 0);
  } finally {
    await fixture.close();
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/task-scheduler.test.mjs
```

预期：FAIL，报错 `fixture.scheduler.finalize is not a function`

- [ ] **步骤 3：编写实现**

在 `runTask` 之后加：

```js
  finalize(task, run) {
    const current = this.database.getTask(task.id);
    // agent 自己收过尾（in_review），或任务被人手挪走了 → 不插手
    if (!current || current.status !== "in_progress") return current;

    const details = [
      `run 状态：${run.status}`,
      `退出码：${run.exitCode ?? "（无，进程被信号终止或被中断）"}`,
      run.error ? `错误：${run.error}` : null,
    ].filter(Boolean).join("\n");
    this.database.createComment(task.id, {
      body: `⚠️ 执行未完成\n\n${details}\n\nagent 退出时这条任务仍停在「处理中」，已自动移到「等你确认」，请人工看一眼。`,
      threadId: null,
      actor: SCHEDULER_ACTOR,
    });

    const fresh = this.database.getTask(task.id);
    return this.database.moveTask(
      fresh.id,
      fresh.version,
      "in_review",
      undefined,
      null,
      SCHEDULER_ACTOR,
    );
  }
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/task-scheduler.test.mjs
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
cd /home/work/vdc/dashi-taskboard \
  && git add server/task-scheduler.mjs test/task-scheduler.test.mjs \
  && git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
     commit -m "feat: fall back to in_review when the agent does not finish (任务 8/16)"
```

---

## 任务 9：轮询主循环（并发闸门 + 项目级间隔）

**文件：**
- 修改：`server/task-scheduler.mjs`
- 测试：`test/task-scheduler.test.mjs`（追加）

规格 §6.3：并发上限可配默认 2，当前 running 数**直接查 `SELECT COUNT(*) FROM ai_chat_runs WHERE status='running'`**，不另维护计数器。这样用户在网页里手开的对话也会占名额，是想要的效果。

只有一处必须加本地计数：一轮里连续 `startTurn` 时，前一个的 run 行还没落库，`COUNT(*)` 仍是 0，上限会形同虚设。所以闸门是 `countRunningAiChatRuns() + this.pending.size`，`pending` 在 run 行建出来后立刻清（任务 7 的 `onStarted` 回调就是为这个留的）。

项目级 `intervalMinutes` 的语义（见「与规格的偏离」第二处）：**同一项目两次认领之间的最小间隔**，用内存里的 `lastClaimedAt` 实现；全局 `scheduler_interval_ms` 只管循环多久醒一次。

- [ ] **步骤 1：编写失败的测试**

```js
test("tick 受并发上限约束，并遵守项目级 intervalMinutes 间隔", async () => {
  const fixture = await createFixture({ concurrency: 2, holdMs: 300 });
  try {
    fixture.database.setProjectAutomation("project", { enabledByUser: true, intervalMinutes: 5 });
    for (let index = 0; index < 5; index += 1) fixture.createTodo(`任务 ${index}`);

    const pending = await fixture.scheduler.tick();
    assert.equal(pending.length, 2);
    assert.equal(
      fixture.database.listTasks({ projectId: "project", status: "todo", archived: "false" }).length,
      3,
    );
    await waitFor(() => fixture.database.countRunningAiChatRuns() === 2);

    // 名额占满 → 再 tick 一次不认领
    assert.deepEqual(await fixture.scheduler.tick(), []);
    await Promise.all(pending);
    assert.equal(fixture.database.countRunningAiChatRuns(), 0);

    // 名额空了，但项目级 5 分钟间隔没到 → 仍不认领
    assert.deepEqual(await fixture.scheduler.tick(), []);

    // 把上次认领时间往前拨 6 分钟 → 放行下一批
    fixture.scheduler.lastClaimedAt.set("project", Date.now() - 6 * 60_000);
    const next = await fixture.scheduler.tick();
    assert.equal(next.length, 2);
    await Promise.all(next);

    // 本次改造的核心 bug 回归：跑过的 4 条任务必须是 4 个互不相同的会话，
    // 旧脚本是整个进程共用一个 threadId
    const threadIds = fixture.database.listAiChatThreads().map((thread) => thread.id);
    assert.equal(threadIds.length, 4);
    assert.equal(new Set(threadIds).size, 4);
  } finally {
    await fixture.close();
  }
});

test("automation 未开启的项目不会被认领", async () => {
  const fixture = await createFixture();
  try {
    const task = fixture.createTodo("不该被碰");
    assert.deepEqual(await fixture.scheduler.tick(), []);
    assert.equal(fixture.database.getTask(task.id).status, "todo");
  } finally {
    await fixture.close();
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/task-scheduler.test.mjs
```

预期：FAIL，报错 `fixture.scheduler.tick is not a function`

- [ ] **步骤 3：编写实现**

在 `finalize` 之后加：

```js
  async #execute(task, project) {
    this.pending.add(task.id);
    try {
      const run = await this.runTask(task, project, () => this.pending.delete(task.id));
      this.finalize(task, run);
    } catch (error) {
      // createThread / startTurn 自己抛错（THREAD_BUSY、AI_CHAT_ISSUE_NOT_FOUND 等）也要兜底，
      // 否则任务永远卡在 in_progress 占着名额
      this.finalize(task, {
        status: "failed",
        exitCode: null,
        error: error?.message ?? String(error),
      });
    } finally {
      this.pending.delete(task.id);
    }
  }

  async tick() {
    const { concurrency } = this.config();
    const startedAt = Date.now();
    const started = [];
    for (const project of this.database.listProjectsWithAutomationEnabled()) {
      const lastClaimedAt = this.lastClaimedAt.get(project.projectId);
      const gapMs = project.automation.intervalMinutes * 60_000;
      if (lastClaimedAt !== undefined && startedAt - lastClaimedAt < gapMs) continue;
      const todos = this.database.listTasks({
        projectId: project.projectId,
        status: "todo",
        archived: "false",
      });
      for (const task of todos) {
        if (this.database.countRunningAiChatRuns() + this.pending.size >= concurrency) {
          return started;
        }
        const claimed = this.claimTask(task);
        if (!claimed) continue;
        this.lastClaimedAt.set(project.projectId, Date.now());
        started.push(this.#execute(claimed, project));
      }
    }
    return started;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // tick 内部已经把每条任务的异常吞在 #execute 里，这里只兜 tick 自身的同步/查询异常
      this.tick().catch((error) => {
        console.error("[task-scheduler] tick failed:", error);
      });
    }, this.config().intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
```

`tick()` 返回的是一个 **promise 数组**（每条任务一个），定时器路径直接丢掉，测试里 `await Promise.all(...)` 用来同步等这一批跑完。`timer.unref()` 是必须的，否则 `node --test` 会挂住不退出。

- [ ] **步骤 4：运行测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/task-scheduler.test.mjs
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
cd /home/work/vdc/dashi-taskboard \
  && git add server/task-scheduler.mjs test/task-scheduler.test.mjs \
  && git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
     commit -m "feat: add the scheduler polling loop with a concurrency gate (任务 9/16)"
```

---

## 任务 10：把 scheduler 接进 server 进程 + 手动触发接口

**文件：**
- 修改：`server/app.mjs`（顶部 import、`:1517-1525` 之后建实例、`listen()` 里 `start()`、`close()` 里 `stop()`、新增一条 `/api/local/*` 路由）
- 测试：`test/server.test.mjs`（追加一个用例）

规格 §3 决策 1：scheduler 跑在 taskboard server 进程内，npm 脚本只是打同一个 HTTP 接口的入口。所以这里既要接上定时循环，也要留一个手动触发的接口给任务 12 的 npm 脚本用。

`test/server.test.mjs` 已经有真 HTTP 测试骨架，直接复用，**不要新建 fixture**：
- `startServer(configure, listenOptions)`（`test/server.test.mjs:22-29`）建 tmpdir + `createTaskboardServer` + `listen({port: 0})`，返回 `http://127.0.0.1:<port>`
- `request(baseUrl, pathname, options)`（`:31-48`）返回 `{ response, body }`，body 已 `JSON.parse`
- 文件顶部的 `afterEach`（`:14-20`）负责 `app.close()` + 删 tmpdir，用例里不用自己收尾

- [ ] **步骤 1：编写失败的测试**

追加到 `test/server.test.mjs` 末尾：

```js
test("the local scheduler exposes a manual tick endpoint", async () => {
  const baseUrl = await startServer();

  const tick = await request(baseUrl, "/api/local/ai/scheduler/tick", { method: "POST" });
  assert.equal(tick.response.status, 200);
  // 默认项目的 automation 是关闭的，所以一条都不该被认领
  assert.deepEqual(tick.body, { started: 0, concurrency: 2, intervalMs: 300_000 });

  const wrongMethod = await request(baseUrl, "/api/local/ai/scheduler/tick");
  assert.equal(wrongMethod.response.status, 405);
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/server.test.mjs
```

预期：FAIL，tick 返回 404

- [ ] **步骤 3：加 import 与实例**

`server/app.mjs` 顶部 import 区加一行（放在 `AiChatService` 的 import 附近，保持字母序不是硬要求，跟着周围风格走）：

```js
import { TaskScheduler } from "./task-scheduler.mjs";
```

在 `const aiChat = new AiChatService({...});`（`server/app.mjs:1517-1525`）之后、`const projectSummary = new ProjectSummaryService({...});` 之前插入：

```js
  const scheduler = new TaskScheduler({
    database,
    aiChat,
    manageTaskboardSkillPath: resolved.skillPath,
    processEnv: codexProcessEnvironment,
  });
```

- [ ] **步骤 4：加路由**

在 `if (pathname === "/api/local/ai/catalog") {`（`server/app.mjs:1970`）之前插入：

```js
      if (pathname === "/api/local/ai/scheduler/tick") {
        assertNoQuery(url.searchParams, "/api/local/ai/scheduler/tick");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const started = await scheduler.tick();
        const { concurrency, intervalMs } = scheduler.config();
        return sendJson(response, 200, { started: started.length, concurrency, intervalMs });
      }
```

`/api/local/*` 前缀已经被 loopback 校验挡过一层（`server/app.mjs:250`），这条不用再自己判来源。

- [ ] **步骤 5：接上生命周期**

`listen()` 里 `listening = true;` 之后（`server/app.mjs:2800-2801`）加一行：

```js
      scheduler.start();
```

`close()` 里 `await aiChat.close();`（`server/app.mjs:2812`）**之前**加一行：

```js
      scheduler.stop();
```

顺序不能反：先停定时器再关 aiChat，否则可能在关闭过程中又起一轮 spawn。

- [ ] **步骤 6：运行测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/server.test.mjs test/task-scheduler.test.mjs
```

预期：PASS

- [ ] **步骤 7：Commit**

```bash
cd /home/work/vdc/dashi-taskboard \
  && git add server/app.mjs test/server.test.mjs \
  && git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
     commit -m "feat: run the task scheduler inside the taskboard server (任务 10/16)"
```

---

## 任务 11：自动化配置的真 HTTP 接口

**文件：**
- 修改：`server/app.mjs`（在 `projectRoute` 之后加一条 `projectAutomationRoute`）
- 测试：`test/server.test.mjs`（追加）

规格 §8.3：现在的自动化设置**没有 HTTP 接口** —— `web/src/App.tsx:979-1015` 发 host message，`scripts/codex-injector.mjs:913-997` 用 CDP `Runtime.evaluate` 转成 `vscode://codex/<method>`，整条链路要求 codex app 在跑。这一步先把服务端接口补齐，前端切过来是 B 计划的事。

抄现成的路由骨架：`projectRoute`（`server/app.mjs:2146-2163`）已经把「拒绝 query 参数 + `decodeURIComponent` 失败给 `INVALID_PATH` + `validateProjectId`」这套写全了，照它写。校验 body 用 `/api/local/ai/backend`（`:1946-1968`）那套 `assertPlainObject` + `assertAllowedKeys`。

- [ ] **步骤 1：编写失败的测试**

追加到 `test/server.test.mjs`：

```js
test("project automation options round-trip over HTTP", async () => {
  const baseUrl = await startServer();
  const created = await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "automated", name: "Automated" },
  });
  assert.equal(created.response.status, 201);

  const initial = await request(baseUrl, "/api/projects/automated/automation");
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.body, {
    automation: { enabledByUser: false, intervalMinutes: 5, model: null, reasoningEffort: null },
  });

  const patched = await request(baseUrl, "/api/projects/automated/automation", {
    method: "PATCH",
    body: { enabledByUser: true, intervalMinutes: 15 },
  });
  assert.equal(patched.response.status, 200);
  assert.deepEqual(patched.body, {
    automation: { enabledByUser: true, intervalMinutes: 15, model: null, reasoningEffort: null },
  });

  // 浅合并：只带一个字段不会把其他字段冲掉
  const again = await request(baseUrl, "/api/projects/automated/automation", {
    method: "PATCH",
    body: { model: "gpt-real" },
  });
  assert.deepEqual(again.body.automation, {
    enabledByUser: true, intervalMinutes: 15, model: "gpt-real", reasoningEffort: null,
  });

  const unknownKey = await request(baseUrl, "/api/projects/automated/automation", {
    method: "PATCH",
    body: { quotaAware: true },
  });
  assert.equal(unknownKey.response.status, 400);

  const badInterval = await request(baseUrl, "/api/projects/automated/automation", {
    method: "PATCH",
    body: { intervalMinutes: 0 },
  });
  assert.equal(badInterval.response.status, 400);

  const missing = await request(baseUrl, "/api/projects/nope/automation");
  assert.equal(missing.response.status, 404);

  const wrongMethod = await request(baseUrl, "/api/projects/automated/automation", {
    method: "DELETE",
  });
  assert.equal(wrongMethod.response.status, 405);
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/server.test.mjs
```

预期：FAIL，第一个 GET 返回 404

- [ ] **步骤 3：编写实现**

在 `projectRoute` 那段（`server/app.mjs:2163` 的右花括号）之后插入：

```js
      const projectAutomationRoute = pathname.match(/^\/api\/projects\/([^/]+)\/automation$/);
      if (projectAutomationRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectAutomationRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method === "GET") {
          return sendJson(response, 200, { automation: database.getProjectAutomation(projectId) });
        }
        if (request.method === "PATCH") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(
            body,
            new Set(["enabledByUser", "intervalMinutes", "model", "reasoningEffort"]),
          );
          if (Object.hasOwn(body, "enabledByUser") && typeof body.enabledByUser !== "boolean") {
            throw new ApiError(400, "INVALID_FIELD", "enabledByUser must be a boolean");
          }
          if (Object.hasOwn(body, "intervalMinutes")
            && !(Number.isInteger(body.intervalMinutes) && body.intervalMinutes > 0)) {
            throw new ApiError(400, "INVALID_FIELD", "intervalMinutes must be a positive integer");
          }
          for (const key of ["model", "reasoningEffort"]) {
            if (Object.hasOwn(body, key) && body[key] !== null && typeof body[key] !== "string") {
              throw new ApiError(400, "INVALID_FIELD", `${key} must be a string or null`);
            }
          }
          return sendJson(response, 200, {
            automation: database.setProjectAutomation(projectId, body),
          });
        }
        return methodNotAllowed(response, ["GET", "PATCH"]);
      }
```

`getProjectAutomation` 对不存在的项目抛 `ApiError(404, "PROJECT_NOT_FOUND")`（任务 2 已实现），所以 404 不用在路由里再判一次。

- [ ] **步骤 4：运行测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard && node --test test/server.test.mjs
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
cd /home/work/vdc/dashi-taskboard \
  && git add server/app.mjs test/server.test.mjs \
  && git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
     commit -m "feat: expose project automation options over HTTP (任务 11/16)"
```

---

## 任务 12：本地 npm 脚本改成薄 HTTP 客户端

现在的 `scripts/taskboard-automation-local.mjs` 自己 spawn codex、自己调 taskctl，而且**全程复用同一个 `threadId`**（第 12 行 `crypto.randomUUID()` 只算一次），这正是用户报的 bug。调度逻辑现在全在服务端（任务 1–10），这个脚本只需要定时 POST 一次接口。

**文件：**
- 重写：`scripts/taskboard-automation-local.mjs`（现 52 行，整体替换）
- 测试：`test/server.test.mjs`（追加，沿用文件顶部已有的 `startServer` harness）

- [ ] **步骤 1：编写失败的测试**

追加到 `test/server.test.mjs` 末尾。文件顶部若没有这两个 import，补上：

```js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
```

```js
test("本地自动化脚本单次执行会打到 scheduler tick 接口", async () => {
  const baseUrl = await startServer();
  const script = fileURLToPath(new URL("../scripts/taskboard-automation-local.mjs", import.meta.url));
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        CODEX_TASKBOARD_URL: baseUrl,
        // 0 = 只跑一轮就退出，测试不能挂在定时器上
        TASKBOARD_INTERVAL_MS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`exit ${code}: ${stderr}`));
    });
  });
  // 没有任何项目开自动化 → started=0，但接口必须真的通了
  assert.match(output, /started=0/);
  assert.match(output, /concurrency=/);
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd /home/work/vdc/dashi-taskboard \
  && node --test --test-name-pattern "本地自动化脚本单次执行" test/server.test.mjs
```

预期：FAIL。旧脚本会去 spawn `codex` 和 taskctl，stdout 里不会出现 `started=0`。

- [ ] **步骤 3：整体重写脚本**

`scripts/taskboard-automation-local.mjs` 全文替换为：

```js
#!/usr/bin/env node
// 本地自动化循环：定时敲一次服务端调度接口。
// 真正的「取任务 → 建会话 → 跑 agent → 收尾」全在 server/task-scheduler.mjs 里，
// 这里不 spawn agent、不碰 taskctl，也不持有任何会话 id
// （旧版整个进程共用一个 threadId，导致所有任务串到同一个会话上）。
const baseUrl = (process.env.CODEX_TASKBOARD_URL ?? "http://127.0.0.1:47823").replace(/\/+$/, "");
const interval = Number(process.env.TASKBOARD_INTERVAL_MS ?? 300_000);

if (!Number.isFinite(interval) || interval < 0) {
  throw new Error("TASKBOARD_INTERVAL_MS must be a non-negative number");
}

async function tick() {
  const response = await fetch(`${baseUrl}/api/local/ai/scheduler/tick`, { method: "POST" });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`tick failed with ${response.status}: ${text}`);
  }
  const body = JSON.parse(text);
  console.log(
    `[taskboard] started=${body.started} concurrency=${body.concurrency} intervalMs=${body.intervalMs}`,
  );
}

do {
  try {
    await tick();
  } catch (error) {
    // 服务没起来、正在重启都会走到这里；不退出，下一轮再试
    console.error(`[taskboard] ${error.message}`);
  }
  if (interval > 0) await new Promise((resolve) => setTimeout(resolve, interval));
} while (interval > 0);
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard \
  && node --test --test-name-pattern "本地自动化脚本单次执行" test/server.test.mjs
```

预期：PASS

- [ ] **步骤 5：Commit**

`package.json` 里的 `"taskboard:automation": "node scripts/taskboard-automation-local.mjs"` **在工作区已存在但未提交**，且和用户自己的 `allowScripts` 改动挤在同一个文件 diff 里。**不要 stage `package.json`** —— 会顺手把用户的无关改动一起提交。脚本入口留作手工验证项。

```bash
cd /home/work/vdc/dashi-taskboard \
  && git add scripts/taskboard-automation-local.mjs test/server.test.mjs \
  && git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
     commit -m "refactor: drive local automation loop through the scheduler API (任务 12/16)"
```

---

## 任务 13：在「等你确认」里追问会把任务拉回「处理中」

规格 §7.5 路径 A：任务停在 `in_review`，用户在会话里追加一条消息要 agent 继续改 —— 任务必须自动回到 `in_progress`，否则看板上它一直挂在「等你确认」，调度器也不会再管它。

顺带把 agent actor 去重：`server/app.mjs:56` 有 `CODEX_AGENT_ACTOR`，任务 4 又在 `server/task-scheduler.mjs` 抄了一份 `SCHEDULER_ACTOR`，本任务再抄第三份就不像话了 —— 提到 `shared/agent-actor.mjs`。

**文件：**
- 创建：`shared/agent-actor.mjs`
- 修改：`server/app.mjs:56-61`（删掉本地常量，改成 import）
- 修改：`server/task-scheduler.mjs`（删掉 `SCHEDULER_ACTOR` 定义，改成 import `AGENT_ACTOR`，替换 3 处引用）
- 修改：`server/ai-chat.mjs:342` 之后（插入回退逻辑）
- 测试：`test/ai-chat-runner.test.mjs`（追加）

- [ ] **步骤 1：先做 actor 提取（纯重构，无行为变化）**

创建 `shared/agent-actor.mjs`：

```js
// agent 写库时的统一身份。id 是 wire 值：parseAssigneeTarget（server/app.mjs:568）校验它，
// 前端发它，历史 tasks/comments/task_activities 行的 actor_id 已经存了它 —— 不能改。
export const AGENT_ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};
```

`server/app.mjs`：删掉 `:56-61` 的 `const CODEX_AGENT_ACTOR = {...}`，在顶部 import 区加 `import { AGENT_ACTOR } from "../shared/agent-actor.mjs";`，把 `:516` 和 `:568` 两处 `CODEX_AGENT_ACTOR` 改成 `AGENT_ACTOR`。

`server/task-scheduler.mjs`：删掉 `export const SCHEDULER_ACTOR = {...}`，加 `import { AGENT_ACTOR } from "../shared/agent-actor.mjs";`，把类里 3 处 `SCHEDULER_ACTOR`（`claimTask` 的 `moveTask`、`finalize` 的 `createComment` 与 `moveTask`）改成 `AGENT_ACTOR`。

跑一遍确认没跑偏：

```bash
cd /home/work/vdc/dashi-taskboard \
  && node --test test/server.test.mjs test/task-scheduler.test.mjs
```

预期：PASS（这一步不改任何行为）

- [ ] **步骤 2：编写失败的测试**

追加到 `test/ai-chat-runner.test.mjs` 末尾：

```js
test("在等你确认状态下追问会把任务拉回处理中", async () => {
  const fixture = await createFixture();
  try {
    const actor = { type: "user", id: "reviewer", name: "Reviewer", avatarUrl: null };
    const task = fixture.database.createTask({
      projectId: "project",
      title: "改一下配色",
      description: "",
      status: "in_review",
      priority: "none",
      labels: [],
      threadId: null,
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const thread = await fixture.service.createThread({
      projectId: "project",
      issueId: task.id,
    });

    const run = await fixture.service.startTurn(thread.id, { message: "标题再大一号" });
    await waitFor(() => fixture.service.getRun(run.id)?.status !== "running");

    assert.equal(fixture.database.getTask(task.id).status, "in_progress");
    const notice = fixture.service.getThreadSnapshot(thread.id).events.find(
      (event) => event.data?.taskReopened,
    );
    assert.equal(notice.role, "activity");
    assert.match(notice.content, /处理中/);
  } finally {
    await fixture.close();
  }
});
```

- [ ] **步骤 3：运行测试验证失败**

```bash
cd /home/work/vdc/dashi-taskboard \
  && node --test --test-name-pattern "追问会把任务拉回处理中" test/ai-chat-runner.test.mjs
```

预期：FAIL，`in_review !== in_progress`

- [ ] **步骤 4：实现回退逻辑**

`server/ai-chat.mjs` 顶部 import 区加：

```js
import { AGENT_ACTOR } from "../shared/agent-actor.mjs";
```

紧跟在 `staleBackend` 提示块（`:331-342` 那个 `if (staleBackend) { ... }`）之后插入：

```js
      const boundIssueId = thread.origin?.issueId ?? null;
      if (boundIssueId) {
        const issue = this.database.getTask(boundIssueId);
        // 用户在「等你确认」里追问 = 要 agent 接着改，把任务拉回「处理中」（规格 §7.5 路径 A）。
        // 这里是同步读改，中间没有 await，不会撞版本号。
        if (issue && issue.status === "in_review" && issue.archivedAt == null) {
          const reopened = this.database.moveTask(
            issue.id,
            issue.version,
            "in_progress",
            undefined,
            null,
            AGENT_ACTOR,
          );
          const notice = this.database.insertAiChatEvent({
            threadId,
            runId: run.id,
            type: "agent_message",
            role: "activity",
            content: `任务 ${reopened.identifier} 已从「等你确认」移回「处理中」。`,
            data: {
              status: "completed",
              taskReopened: { taskId: reopened.id, from: "in_review", to: "in_progress" },
            },
          });
          this.#emit(threadId, { type: "ai.event", event: notice });
        }
      }
```

只认 `in_review`：`todo` 不动（调度器认领时才该动），`in_progress` 本来就对，`done` 是人明确关掉的，不该被一条追问拽回来。

- [ ] **步骤 5：运行测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard \
  && node --test test/ai-chat-runner.test.mjs test/server.test.mjs test/task-scheduler.test.mjs
```

预期：PASS

- [ ] **步骤 6：Commit**

```bash
cd /home/work/vdc/dashi-taskboard \
  && git add shared/agent-actor.mjs server/app.mjs server/task-scheduler.mjs server/ai-chat.mjs test/ai-chat-runner.test.mjs \
  && git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
     commit -m "feat: reopen an in_review task when the user follows up (任务 13/16)"
```

---

## 任务 14：development-contexts 不再猜 codex 会话的 cwd

`resolveProjectWorkspace`（`server/app.mjs:1078-1096`）为了拿工作区，先读 `.codex-global-state.json` 的 `thread-project-assignments`，再去翻 codex 进程管理器的 `chat_processes.json` 找同 `conversationId` 的最新 `cwd`。这两个文件都是 codex app 的私有产物，脱离 codex app 后永远读不到。工作区的正经来源只有两个：codex-state 的 `local-projects`（`loadDeviceWorkspaces` 已经在读）和项目自己的 `workspacePath`。

**文件：**
- 修改：`server/app.mjs`（删 `latestThreadCwd` `:1063-1076` 与 `resolveProjectWorkspace` `:1078-1096`；改路由 `:2222-2275`；删 `codexProcessesPath` 选项 `:1328-1329`）
- 修改：`web/src/api.ts:429-445`
- 修改：`web/src/App.tsx:1631-1668`
- 测试：`test/server.test.mjs:1019-1051`（重写这条用例）

`codexProjectRoot`（`:1042`）和 `readCodexProjectWorkspaces`（`:1049`）**留着**，`/api/device-workspaces`（`:2073-2080`）还在用。

- [ ] **步骤 1：改测试（先让它失败）**

把 `test/server.test.mjs:1019-1051` 整条 `test("development context scan resolves the current Codex conversation workspace", ...)` 替换为：

```js
test("development context scan resolves the workspace from project state only", async () => {
  let expectedWorkspace;
  const baseUrl = await startServer(async (directory) => {
    expectedWorkspace = await realpath(directory);
    const statePath = path.join(directory, "codex-state.json");
    await writeFile(statePath, JSON.stringify({
      "local-projects": { local: { rootPaths: [directory] } },
    }));
    return { codexStatePath: statePath };
  });
  const result = await request(baseUrl, "/api/projects/local/development-contexts");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.workspacePath, expectedWorkspace);
  assert.deepEqual(result.body.contexts, []);

  // 显式指定设备工作区仍然优先
  const deviceWorkspace = path.join(expectedWorkspace, "another-device-workspace");
  const deviceResult = await request(
    baseUrl,
    `/api/projects/local/development-contexts?workspacePath=${encodeURIComponent(deviceWorkspace)}`,
  );
  assert.equal(deviceResult.response.status, 200);
  assert.equal(deviceResult.body.workspacePath, deviceWorkspace);

  // 两个 codex 猜测参数彻底下线
  for (const query of ["codexThreadId=019f7f96-287b-7da0-bc7f-ffe03af85cc8", "codexProjectId=local"]) {
    const rejected = await request(baseUrl, `/api/projects/local/development-contexts?${query}`);
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.body.error.code, "UNKNOWN_QUERY_PARAMETER");
  }
});
```

文件顶部 `node:fs/promises` 的 import 加上 `realpath`：

```js
import { access, chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd /home/work/vdc/dashi-taskboard \
  && node --test --test-name-pattern "development context scan" test/server.test.mjs
```

预期：FAIL，`codexThreadId` 那两次请求返回 200 而不是 400。

- [ ] **步骤 3：改服务端**

`server/app.mjs`：

1. 删掉 `latestThreadCwd`（`:1063-1076`）和 `resolveProjectWorkspace`（`:1078-1096`）两个函数。
2. 删掉 `resolveOptions` 里的 `codexProcessesPath`（`:1328-1329`）—— 删完全仓库不再有引用。
3. 顶部 `import { resolveAiWorkspace, resolveMappedAiWorkspace } from "./ai-chat-catalog.mjs";` 加上 `loadDeviceWorkspaces`：

```js
import { loadDeviceWorkspaces, resolveAiWorkspace, resolveMappedAiWorkspace } from "./ai-chat-catalog.mjs";
```

4. 路由里把查询参数白名单和工作区解析改掉。`:2225-2227` 的 `unknownQuery` 白名单只留 `workspacePath`：

```js
        const unknownQuery = [...url.searchParams.keys()].filter((key) => key !== "workspacePath");
```

删掉 `:2247-2254` 的 `codexProjectId` / `codexThreadId` 两个 `stringField` 块，把 `:2263-2269` 换成：

```js
        const workspacePath = deviceWorkspacePath
          ?? (await loadDeviceWorkspaces(resolved.codexStatePath, database)).get(projectId)
          ?? project.workspacePath
          ?? null;
```

`loadDeviceWorkspaces` 只返回真实存在的目录（内部 `realpath` + `stat`），拿不到时回落到项目登记的 `workspacePath`（云端模式下 `project` 是合成对象，DB 里没这行，靠这一路兜住），最后 `null` 交给 `scanDevelopmentContexts` 返回空扫描结果 —— 与改造前的宽容行为一致。

- [ ] **步骤 4：改前端**

`web/src/api.ts:429-445` 换成：

```ts
export async function listDevelopmentContexts(
  projectId: string,
  signal?: AbortSignal,
  workspacePath?: string,
): Promise<DevelopmentScan> {
  const suffix = workspacePath
    ? `?${new URLSearchParams({ workspacePath })}`
    : "";
  return request<DevelopmentScan>(
    `/api/projects/${encodeURIComponent(projectId)}/development-contexts${suffix}`,
    { signal },
  );
}
```

`web/src/App.tsx:1631-1668` 的 effect：删掉 `codexProjectId` / `codexThreadId` 两个局部变量（`:1637-1638`），调用改成三参数，依赖数组去掉 `detailTask?.threadId` / `hostContext?.projectId` / `hostContext?.threadId`：

```tsx
    void listDevelopmentContexts(
      selectedProjectId,
      controller.signal,
      selectedDeviceWorkspacePath,
    )
```

```tsx
  }, [
    rememberDeviceWorkspacePath,
    selectedProjectId,
    selectedDeviceWorkspacePath,
  ]);
```

`test/project-home.test.mjs:31` 断言的是 `listDevelopmentContexts([\s\S]*?selectedDeviceWorkspacePath,[\s\S]*?)`，改成三参数后仍然匹配，不用动。

- [ ] **步骤 5：运行测试与类型检查验证通过**

```bash
cd /home/work/vdc/dashi-taskboard \
  && node --test test/server.test.mjs test/project-home.test.mjs \
  && npx tsc --noEmit -p web/tsconfig.json
```

预期：两条都 PASS，tsc 无输出。若 tsc 报 `hostContext` 或 `detailTask` 变成未使用，说明它们只被这个 effect 用 —— 检查其他引用后再决定是否删除声明（多半还有别的使用者，不要贸然删）。

- [ ] **步骤 6：Commit**

```bash
cd /home/work/vdc/dashi-taskboard \
  && git add server/app.mjs web/src/api.ts web/src/App.tsx test/server.test.mjs \
  && git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
     commit -m "refactor: resolve development contexts without Codex process state (任务 14/16)"
```

---

## 任务 15：workflow-capabilities 走 adapter，不再硬编码 codex

`/api/workflow-capabilities`（`server/app.mjs:2083-2109`）现在无条件 spawn `codex app-server --stdio` 拿 skills、`codex mcp list --json` 拿 MCP。默认后端是 ducc 时这两条命令都不存在，工作流面板直接 500。给 adapter 契约加第 9 个字段 `discoverWorkflowCapabilities`。

顺带把 `server/app.mjs:1148-1261` 的 `discoverSkills` 删掉 —— 它和 `server/ai-chat-catalog.mjs` 的 `listSkills` + `sanitizeSkills`（`:137` / `:220`）是同一套逻辑抄了两遍。

**文件：**
- 修改：`server/ai-chat-catalog.mjs`（导出 `discoverCodexSkills`）
- 修改：`server/agent-backends/codex.mjs`（加 `discoverWorkflowCapabilities`，把 mcp 探测搬进来）
- 修改：`server/agent-backends/ducc.mjs`（抽 `discoverDuccSkills`，加 `discoverWorkflowCapabilities`）
- 修改：`server/ai-chat.mjs`（加公开方法 `discoverWorkflowCapabilities`）
- 修改：`server/app.mjs`（删 `:1148-1295` 三个函数、改路由、收窄 `node:child_process` import）
- 测试：`test/server.test.mjs:742-809`（两条既有用例补 `agentBackendId: "codex"`，新增一条 ducc 用例）

- [ ] **步骤 1：改测试（先让它失败）**

`test/server.test.mjs:744-761`，`startServer` 的返回值补上后端：

```js
    return { agentBackendId: "codex", codexExecutable };
```

`test/server.test.mjs:803-805` 同样：

```js
  const baseUrl = await startServer(async (directory) => ({
    agentBackendId: "codex",
    codexExecutable: path.join(directory, "missing-codex"),
  }));
```

再追加一条 ducc 用例：

```js
test("ducc 后端的工作流能力来自本地 skill 目录且没有 MCP", async () => {
  let workspacePath;
  const baseUrl = await startServer(async (directory) => {
    workspacePath = directory;
    const skillDirectory = path.join(directory, ".claude", "skills", "demo-skill");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, "SKILL.md"), "---\ndescription: 本地技能\n---\n");
    const emptyHome = path.join(directory, "empty-home");
    await mkdir(emptyHome);
    return {
      agentBackendId: "ducc",
      // HOME 指到空目录，否则会把跑测试这台机器上真实的 ~/.claude/skills 扫进来
      processEnv: { ...process.env, HOME: emptyHome },
    };
  });
  const result = await request(
    baseUrl,
    `/api/workflow-capabilities?workspacePath=${encodeURIComponent(workspacePath)}`,
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.mcpServers, []);
  assert.deepEqual(result.body.skills.map((skill) => skill.id), ["demo-skill"]);
  assert.equal(result.body.skills[0].scope, "repo");
});
```

`node:fs/promises` 的 import 加上 `mkdir`。`SKILL.md` 的描述格式要与 `skillDescription`（`server/agent-backends/ducc.mjs:299`）读的字段一致 —— 实现这一步时先去看那个函数，如果它读的不是 frontmatter 的 `description`，就按它真正读的写法造这个文件。

- [ ] **步骤 2：运行测试验证失败**

```bash
cd /home/work/vdc/dashi-taskboard \
  && node --test --test-name-pattern "工作流能力|workflow capabilit" test/server.test.mjs
```

预期：ducc 那条 FAIL（现在无条件走 codex，探测不到 ducc 的 skill 目录）。

- [ ] **步骤 3：`server/ai-chat-catalog.mjs` 导出 codex 的 skill 探测**

在 `discoverAiCatalog`（`:251`）之前插入：

```js
export async function discoverCodexSkills({ codexExecutable, workspacePath, processEnv }) {
  const environment = withoutTaskboardLauncherEnvironment(processEnv);
  return sanitizeSkills(await listSkills(codexExecutable, workspacePath, environment));
}
```

- [ ] **步骤 4：`server/agent-backends/codex.mjs` 实现新字段**

顶部 import 补齐：

```js
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { withoutTaskboardLauncherEnvironment } from "../../shared/codex-environment.mjs";
import { resolveCodexExecutable } from "../../shared/codex-executable.mjs";
import { discoverAiCatalog, discoverCodexSkills } from "../ai-chat-catalog.mjs";

const execFileAsync = promisify(execFile);
```

在 `export const codexBackend` 之前加（从 `server/app.mjs:1263-1287` 原样搬过来，只把参数名对齐）：

```js
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
```

`codexBackend` 对象末尾加字段：

```js
  discoverWorkflowCapabilities: async ({ executable, workspacePath, processEnv }) => {
    const [skills, mcpServers] = await Promise.all([
      discoverCodexSkills({ codexExecutable: executable, workspacePath, processEnv }),
      discoverCodexMcpServers(executable, withoutTaskboardLauncherEnvironment(processEnv)),
    ]);
    return { skills, mcpServers };
  },
```

- [ ] **步骤 5：`server/agent-backends/ducc.mjs` 实现新字段**

把 `discoverDuccCatalog`（`:334-358`）里的 skill 探测抽成导出函数，插在它之前：

```js
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
```

`discoverDuccCatalog` 收缩成：

```js
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
```

`duccBackend` 对象末尾加字段：

```js
  // ducc 没有 `mcp list` 这类命令，MCP 配置散在 ~/.claude.json 里且没有公开的稳定格式，
  // 先返回空数组 —— 工作流面板的 MCP 选项对 ducc 就是空的（已记在「已知限制」）
  discoverWorkflowCapabilities: async ({ workspacePath, processEnv }) => ({
    skills: await discoverDuccSkills({ workspacePath, processEnv }),
    mcpServers: [],
  }),
```

- [ ] **步骤 6：`server/ai-chat.mjs` 加公开方法**

后端 id 与可执行文件的解析链只有 `#backend()` / `#executableFor()` 知道（`:120-134`），所以入口放在 AiChatService 上，不要在 app.mjs 里再抄一遍那条 `?? ?? ??`。紧跟在 `getCatalog`（`:145-148`）之后插入：

```js
  async discoverWorkflowCapabilities(workspacePath) {
    const backend = this.#backend();
    return backend.discoverWorkflowCapabilities({
      executable: this.#executableFor(backend),
      workspacePath,
      processEnv: this.processEnv,
    });
  }
```

- [ ] **步骤 7：`server/app.mjs` 删旧代码、改路由**

1. 删掉 `:1148-1295` 三个函数（`discoverSkills` / `discoverMcpServers` / `discoverWorkflowCapabilities`）。
2. 删完 `spawn` 就没人用了，第 2 行 import 收窄成 `import { execFile } from "node:child_process";`。
3. 路由 `:2100-2108` 换成：

```js
        return sendJson(
          response,
          200,
          await aiChat.discoverWorkflowCapabilities(workspacePath ?? PROJECT_ROOT),
        );
```

`aiChat` 在 `:1517` 就已经建好，而这个路由在 `:2083`，声明顺序没问题。

- [ ] **步骤 8：运行测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard \
  && node --test $(ls test/*.test.mjs | grep -vE "cloud-|inject|task-editor")
```

预期：全绿（含新增用例）。前端调用方 `web/src/components/WorkflowBoard.tsx:517` 用的是 `listWorkflowCapabilities`，响应结构没变，不用动。

- [ ] **步骤 9：Commit**

```bash
cd /home/work/vdc/dashi-taskboard \
  && git add server/ai-chat-catalog.mjs server/agent-backends/codex.mjs server/agent-backends/ducc.mjs server/ai-chat.mjs server/app.mjs test/server.test.mjs \
  && git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
     commit -m "feat: discover workflow capabilities through the agent backend adapter (任务 15/16)"
```

---

## 任务 16：卡片进度条不再读 codex 会话文件

**文件：**
- 修改：`server/app.mjs:3`（import）、`:44`（`CODEX_PLAN_TAIL_BYTES`）、`:1533-1535`、`:1538-1651`、`:1751-1768`
- 修改：`web/src/api.ts:208-222`
- 修改：`web/src/App.tsx:32`、`:94`、`:639-645`、`:1812-1840`、`:1857-1880`
- 修改：`web/src/taskConversations.ts:105-153`
- 测试：`test/server.test.mjs`、`test/ai-chat-ui.test.mjs`

**为什么是删掉而不是改写实现**（这里推翻了本计划开头「文件结构」表里的初版判断，那一行会在本任务里一起改）：

`/api/local/codex-thread-progress` 现在做的事是——按 `threadId` 去 `~/.codex/sessions/**/*-<threadId>.jsonl` 里倒着扒 `update_plan` 工具调用，凑出 `{completed, total, running}`。它的唯一消费者是 `web/src/App.tsx:1812-1840` 的 2 秒轮询，轮询结果作为 `taskCardPresentation` 的第 6 个参数 `taskNativeSession` 喂给卡片进度条。

而入参 `task.threadId` 是 **codex app 写进来的原生会话 id**：调度器不写这一列（见任务 4 的说明，thread 与任务的绑定走 `ai_chat_threads.origin_issue_id`）。也就是说脱离 codex app 之后，`trackedCodexThreadIds`（`:1812`）恒为空数组，这条链路对新产生的任务永远不返回数据。

同时 `taskCardPresentation` 里**已经有一条等价链路**：`web/src/taskConversations.ts:141` 的 `conversations.find((conversation) => conversation.latestTodo)?.latestTodo`。`latestTodo` 由服务端 `#aiChatThreadWithCurrentRun`（`server/database.mjs:2234-2243`）从 `ai_chat_events` 里 `type = 'todo_list'` 的事件算出来，随 `/api/local/ai/threads` 一起下发，不需要额外轮询。这正是规格「删除清单」里写的「进度信息改由 `ai_chat_events` 提供」。

所以本任务是纯删除：服务端去掉会话文件解析和路由，前端去掉轮询和那个第 6 参数。`hostContext` 相关的 `runningNativeThreadId` / `runningNativeTodoProgress`（第 4、5 参数）**保留**——那是 `/api/local/host-runtime` 的另一条链路，归 B 计划处理。

- [ ] **步骤 1：编写失败的测试**

`test/server.test.mjs`，在文件末尾追加：

```js
test("the Codex session-file progress route is gone", async () => {
  const baseUrl = await startServer();
  const missing = await request(
    baseUrl,
    "/api/local/codex-thread-progress?threadId=11111111-2222-3333-4444-555555555555",
  );
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, "NOT_FOUND");
});
```

`test/ai-chat-ui.test.mjs`，在 `const apiSource = ...`（`:24`）下面加一行源码常量：

```js
const taskConversationsSource = await readFile(
  new URL("../web/src/taskConversations.ts", import.meta.url),
  "utf8",
);
```

再在文件末尾追加：

```js
test("card progress comes from the AI thread todo state instead of Codex session files", () => {
  assert.equal(apiSource.includes("codex-thread-progress"), false);
  assert.equal(appSource.includes("getCodexThreadProgress"), false);
  assert.equal(appSource.includes("codexThreadProgress"), false);
  assert.equal(taskConversationsSource.includes("taskNativeSession"), false);
  // 卡片进度只剩 5 个入参：task / aiThreads / unread / hostContext 的两个
  assert.match(
    appSource,
    /taskCardPresentation\(\s*task,\s*aiThreads,\s*unread,\s*runningNativeThreadId,\s*hostContext\?\.threadTodoProgress \?\? null,\s*\)/,
  );
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
cd /home/work/vdc/dashi-taskboard \
  && node --test test/server.test.mjs test/ai-chat-ui.test.mjs
```

预期：FAIL。server 那条报 `Expected values to be strictly equal: 200 !== 404`；ui 那条报 `Expected values to be strictly equal: true !== false`（`apiSource.includes("codex-thread-progress")`）。

- [ ] **步骤 3：删掉服务端的 codex 会话文件解析**

`server/app.mjs`，五处删除：

1. 第 3 行的 import 去掉 `open` 和 `readdir`（删完只剩 `:1011`/`:1018` 用 `stat`）：

```js
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
```

2. 删掉第 44 行的常量：

```js
const CODEX_PLAN_TAIL_BYTES = 16 * 1024 * 1024;
```

3. 删掉 `:1533-1535` 这三行缓存/目录变量（下面 `let hostRuntime = null;` 那行保留）：

```js
  const codexSessionSearches = new Map();
  const codexSessionStateCache = new Map();
  const codexSessionsDirectory = path.join(path.dirname(resolved.codexStatePath), "sessions");
```

4. 删掉 `:1538-1651` 整两个函数 `findCodexSession` 和 `readCodexSessionState`（从 `async function findCodexSession(threadId) {` 一直删到 `readCodexSessionState` 的收尾 `}`，中间的空行一起删，删到 `const server = createServer(async (request, response) => {` 之前）。

5. 删掉 `:1751-1768` 整个路由块（从 `if (pathname === "/api/local/codex-thread-progress") {` 到它的收尾 `}` 和后面那个空行）。删完 `/api/local/client-storage` 的块后面直接接 `/api/local/host-runtime`。

`resolved.codexStatePath` 仍被 `loadDeviceWorkspaces` 用着（任务 14），不要动它。

- [ ] **步骤 4：删掉前端的 API 函数**

`web/src/api.ts`，删掉 `:208-222` 整个 `getCodexThreadProgress`（前后空行留一个）：

```ts
export async function getCodexThreadProgress(
  threadIds: string[],
  signal?: AbortSignal,
): Promise<Record<string, { completed: number | null; total: number | null; running: boolean } | null>> {
  const query = new URLSearchParams();
  for (const threadId of threadIds) query.append("threadId", threadId);
  const data = await request<{
    progress: Record<string, {
      completed: number | null;
      total: number | null;
      running: boolean;
    } | null>;
  }>(`/api/local/codex-thread-progress?${query}`, { signal });
  return data.progress;
}
```

- [ ] **步骤 5：`taskCardPresentation` 去掉第 6 个参数**

`web/src/taskConversations.ts:105-153` 整个函数替换成：

```ts
export function taskCardPresentation(
  task: Task,
  aiThreads: AiChatThread[],
  unread: boolean,
  runningNativeThreadId: string | null = null,
  runningNativeTodoProgress: { completed: number; total: number } | null = null,
): TaskCardPresentation {
  const conversations = taskConversations(task, aiThreads);
  const runningAi = conversations
    .filter((conversation) => conversation.currentRun?.status === "running")
    .sort((left, right) => (
      (right.currentRun?.startedAt ?? "").localeCompare(left.currentRun?.startedAt ?? "")
    ))[0];
  const normalizedRunningNativeThreadId = normalizeCodexThreadId(runningNativeThreadId);
  const runningNative = task.status === "in_progress" && normalizedRunningNativeThreadId
    ? conversations.find((conversation) => (
        normalizeCodexThreadId(conversation.nativeThreadId) === normalizedRunningNativeThreadId
      ))
    : undefined;
  const running = runningAi ?? runningNative;
  const latestTodo = runningAi
    ? runningAi.latestTodo
    : runningNative
      ? runningNativeTodoProgress ?? null
      : conversations.find((conversation) => conversation.latestTodo)?.latestTodo ?? null;
  return {
    conversations,
    unread,
    processing: {
      running: task.status === "in_progress" && Boolean(running),
      completed: latestTodo?.completed ?? null,
      total: latestTodo?.total ?? null,
      startedAt: runningAi?.currentRun?.startedAt ?? null,
    },
  };
}
```

`normalizeCodexThreadId` 在本文件里仍被 `:46`/`:66` 和上面两处用到，导出保持不变。

- [ ] **步骤 6：删掉 App.tsx 的轮询**

`web/src/App.tsx`，五处改动：

1. 删掉 `:32` 的 `  getCodexThreadProgress,` 一行。
2. 删掉 `:94` 的 `  normalizeCodexThreadId,` 一行——它在 App.tsx 里只有 `:1814` 和 `:1863` 两处用，两处都在本任务里删掉了。
3. 删掉 `:639-645` 的 state：

```tsx
  const [codexThreadProgress, setCodexThreadProgress] = useState<
    Record<string, {
      completed: number | null;
      total: number | null;
      running: boolean;
    } | null>
  >({});
```

4. 删掉 `:1812-1840` 的 `trackedCodexThreadIds` / `trackedCodexThreadIdsKey` 和那个 2 秒轮询 effect（从 `const trackedCodexThreadIds = useMemo(...)` 一直删到该 effect 的 `}, [trackedCodexThreadIdsKey]);`）。
5. `:1857-1880` 的 `taskPresentations` 改成：

```tsx
  const taskPresentations = useMemo(() => Object.fromEntries(tasks.map((task) => {
    const unread = (task.status === "in_review" || task.status === "blocked")
      && readActivityKeys[task.id] !== task.activityKey;
    const runningNativeThreadId = hostContext?.threadRunning
      ? hostContext.threadId ?? null
      : null;
    return [task.id, taskCardPresentation(
      task,
      aiThreads,
      unread,
      runningNativeThreadId,
      hostContext?.threadTodoProgress ?? null,
    )];
  })) as Record<string, TaskCardPresentation>, [
    aiThreads,
    hostContext?.threadId,
    hostContext?.threadRunning,
    hostContext?.threadTodoProgress,
    readActivityKeys,
    tasks,
  ]);
```

- [ ] **步骤 7：改掉本计划开头「文件结构」表里那一行**

第 49 行现在写的是：

```
| `findCodexSession`/`readCodexSessionState` → 删 | 路由 `/api/local/codex-thread-progress` 被 `web/src/App.tsx:1826` 每 2s 调一次，喂卡片进度条 | 路由与响应形状**原样保留**，实现改读 `ai_chat_threads.latestTodo` + `currentRun`（任务 16），前端零改动 |
```

改成：

```
| `findCodexSession`/`readCodexSessionState` → 删 | 路由 `/api/local/codex-thread-progress` 被 `web/src/App.tsx:1826` 每 2s 调一次，喂卡片进度条 | 路由**一起删**：入参 `task.threadId` 只有 codex app 会写，调度器不写；`taskCardPresentation` 已有等价的 `latestTodo` 链路（`web/src/taskConversations.ts:141`），前端顺带删掉轮询（任务 16） |
```

- [ ] **步骤 8：运行测试验证通过**

```bash
cd /home/work/vdc/dashi-taskboard \
  && npx tsc --noEmit -p web/tsconfig.json \
  && node --test $(ls test/*.test.mjs | grep -vE "cloud-|inject|task-editor")
```

预期：`tsc` 无输出；`node --test` 的 `ℹ fail 0`。`tsc` 这一步必须过——第 6 步删了两个 import，漏删任何一处引用都会在这里报 `Cannot find name`。

- [ ] **步骤 9：Commit**

```bash
cd /home/work/vdc/dashi-taskboard \
  && git add server/app.mjs web/src/api.ts web/src/App.tsx web/src/taskConversations.ts \
     test/server.test.mjs test/ai-chat-ui.test.mjs \
     docs/superpowers/plans/2026-08-14-taskboard-scheduler.md \
  && git -c user.name="taskboard-local" -c user.email="taskboard-local@localhost" \
     commit -m "refactor: derive card progress from AI thread todos (任务 16/16)"
```

---

## 已知限制（本计划有意留下的，不是漏做）

| 限制 | 出处 | 说明 |
|---|---|---|
| 工作流面板对 ducc 的 MCP 选项恒为空 | 任务 15 | ducc 没有 `mcp list` 之类的命令，配置散在 `~/.claude.json` 里且没有公开稳定格式。要么等 ducc 出命令，要么阶段二自己解析 |
| codex app 时代产生的任务不再显示会话进度 | 任务 16 | 那些任务的 `tasks.thread_id` 是原生 codex 会话 id，进度只存在于 `~/.codex/sessions/*.jsonl`。新任务的进度走 `ai_chat_events` 的 `todo_list`，历史任务没有这类事件 |
| `development-contexts` 不再跟随 agent 当前的 cwd | 任务 14 | 工作区只认 codex-state 的 `local-projects` 和 `projects.workspace_path`。agent 自己 `cd` 到别处不会反映到接口上——这本来就只有 codex app 能提供 |
| 自动化设置页仍在发 host message | 任务 11 只补服务端 | `web/src/App.tsx:979-1015` 切到新接口是 B 计划的任务 |

## 手工验证（自动化测不到的，全部做完 16 个任务后走一遍）

1. **把 `package.json` 的脚本行单独 commit。** 工作区里 `package.json` 已经有 `"taskboard:automation": "node scripts/taskboard-automation-local.mjs"`，但**没提交**，而且 `git diff -- package.json` 里它和用户自己的 `allowScripts` 块混在一起。任务 12 因此完全不碰这个文件。收尾时确认一下：

   ```bash
   cd /home/work/vdc/dashi-taskboard && git diff -- package.json
   ```

   只有确认那个 `allowScripts` 块是不是也该进这次提交之后，再决定怎么 `git add -p`。**不要 `git add package.json` 一把梭。**

2. **真跑一轮 ducc 任务**（规格 §9.3 第一条，假可执行文件替代不了）：

   ```bash
   cd /home/work/vdc/dashi-taskboard \
     && node cli/taskctl.mjs serve --port 47823
   ```

   另开一个终端：确认后端是 ducc → 建项目并开自动化 → 投一条简单 todo（例如「在 README 末尾加一行」）→ 触发一次调度：

   ```bash
   curl -s -X POST http://127.0.0.1:47823/api/local/ai/backend \
     -H 'content-type: application/json' -d '{"backend":"ducc"}'
   curl -s -X POST http://127.0.0.1:47823/api/local/ai/scheduler/tick
   ```

   要确认的四件事：任务从 `todo` 变 `in_progress`；`ai_chat_threads` 多一行且 `backend='ducc'`；agent 自己把任务推到 `in_review`（没推的话看是否落了 `⚠️ 执行未完成` 兜底评论）；网页时间线里能看到这一轮的事件。

3. **连投 3 条任务，确认会话不串。** 这是本次改造要修的 bug，虽然任务 9 有自动化回归，仍值得眼看一遍：3 条任务的会话在网页左侧列表里是 3 条独立记录，各自的时间线互不包含对方的消息。

4. **`npm run taskboard:automation` 的循环行为。** 先不起 server 就跑，确认它打 `[taskboard] fetch failed` 之类的错误但**不退出**；再把 server 起来，确认下一轮自动接上。

5. **卡片进度条。** 任务 16 删掉了 2 秒轮询，进度改由 `latestTodo` 提供。需要一轮真实的、agent 会调 TodoWrite/update_plan 的任务，才能看到卡片上的 `n/m`。如果真实跑下来发现 ducc 的 todo 事件根本没进 `ai_chat_events`（`ITEM_TYPES` 白名单里有 `todo_list`，但 ducc 的事件名未实测），就记一条待办到阶段二，不要在本计划里临时加解析。

6. **切后端后 catalog 真的换了模型列表**（规格 §9.3 第三条，A1 遗留的手验项）：`PATCH /api/local/ai/backend` 在 codex 与 ducc 之间来回切，每次刷新网页看模型下拉的内容是否跟着换。

## 自检结果

按 writing-plans 的三项自检走了一遍，发现并已就地修掉的问题记在这里。

**1. 规格覆盖度。** 规格 §9.2 的 7 条必备用例逐条对位：

| 规格用例 | 落在哪 |
|---|---|
| 每任务独立 thread id | 任务 6（两条任务两个 thread）+ 任务 9（4 条任务 4 个互不相同的 id，端到端）|
| 并发上限生效 | 任务 9 |
| 乐观锁抢占 | 任务 5 —— 用「拿旧版本号的快照再认领一次返回 null」表达两个实例竞争，等价且不需要真起两个进程 |
| 兜底落 in_review | 任务 8 |
| backend 不同不 resume | A1 已实现并有测试（`test/agent-backend-switch.test.mjs`），任务 6 特别标注了不要重写 |
| 两套 adapter | A1 已有 `test/agent-backend-codex.test.mjs` / `test/agent-backend-ducc.test.mjs` |
| in_review 追加反馈 | 任务 13 |

规格 §8.4「要删的 codex 耦合」四项：`chat_processes.json` 猜 cwd → 任务 14；`codex app-server` 拿 skills / `codex mcp list` → 任务 15；会话文件扒进度 → 任务 16；host message 发自动化配置 → 任务 11 补服务端，前端切换归 B。§7.5 路径 A → 任务 13；路径 B（askQuestion）归 B 计划。

**修掉的遗漏：** 任务 9 原来只断言两批各认领 2 条，没有断言「跑过的任务会话互不相同」——而这正是规格里标了「本次核心 bug，必须有回归」的那一条。已在任务 9 步骤 1 末尾补上 `new Set(threadIds).size === 4`。

**2. 占位符扫描。** 全文没有「待定 / TODO / 后续实现 / 类似任务 N」。每个涉及代码的步骤都给了完整代码块而不是描述。两处需要执行者现场判断的地方都写清了判断依据而不是留白：任务 15 步骤 1 要求先看 `server/agent-backends/ducc.mjs:299` 的 `skillDescription` 实际解析哪个字段再信那份 SKILL.md 夹具；手工验证第 5 条给了「ducc 的 todo 事件名未实测」的处理办法（记阶段二，不临时加解析）。

**3. 类型一致性。** 逐个核对了跨任务复用的名字：

- adapter 契约字段名 `discoverWorkflowCapabilities`（任务 15）—— A1 已有的 8 个字段没改名，这是第 9 个
- `AGENT_ACTOR`（任务 13 建 `shared/agent-actor.mjs`）—— 同一个任务里把 `server/app.mjs` 的 `CODEX_AGENT_ACTOR` 和任务 4 建的 `SCHEDULER_ACTOR` 一起换掉了，不会留下三份
- `countRunningAiChatRuns()`（任务 1 建，任务 9 用）、`setProjectAutomation` / `getProjectAutomation`（任务 2 建，任务 9/11 用）、`claimTask`（任务 5 建，任务 9 用）、`finalize`（任务 8 建，任务 9 在它之后插 `tick`）、`onStarted` 回调（任务 7 建，任务 9 用来清 `pending`）—— 签名前后一致
- `discoverCodexSkills`（任务 15 在 `server/ai-chat-catalog.mjs` 新导出）/ `discoverDuccSkills`（任务 15 从 `discoverDuccCatalog` 抽出）—— 两个新导出都只在同一个任务内使用
- `taskCardPresentation` 由 6 参变 5 参（任务 16）—— 唯一调用点 `web/src/App.tsx:1864` 同一步骤里改掉，步骤 8 的 `tsc --noEmit` 兜住

**修掉的两个不一致：**

- 任务标题的层级不统一（任务 1–4 是 `##`，任务 5–16 是 `###`），已全部规范成 `##`
- 任务 15 的注释里引用了「已记在『已知限制』」，但本计划原本没有这个章节 —— 已补上「已知限制」表格，ducc 的 MCP 空列表就记在第一行
- 本计划开头「文件结构」表第 49 行原先判断 `/api/local/codex-thread-progress` 应当保留并改写实现，任务 16 核实后推翻了这个判断（入参 `task.threadId` 调度器不写，等价链路已存在）。任务 16 步骤 7 会把那一行一起改掉，不留矛盾。

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-08-14-taskboard-scheduler.md`。两种执行方式：

**1. 子代理驱动（推荐）** —— 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** —— 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

A1 是用内联方式一口气跑完 13 个任务的（13 个 commit `3312a92`…`24192a2`），本计划规模相当，沿用同一种方式即可。
