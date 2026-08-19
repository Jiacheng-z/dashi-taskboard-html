# 默认 Agent 并发数调整实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将任务自动化调度器在没有显式配置时的默认 Agent 并发数从 2 调整为 5。

**架构：** 保留 `resolveSchedulerConfig` 的现有配置优先级，只修改其最终回退常量。使用现有配置解析测试覆盖默认值、数据库设置和环境变量优先级，不新增配置入口。

**技术栈：** Node.js ESM、`node:test`、`node:assert/strict`

---

## 文件结构

- 修改：`test/task-scheduler.test.mjs` — 更新已有调度器配置解析测试的默认并发断言。
- 修改：`server/task-scheduler.mjs` — 将 `DEFAULT_CONCURRENCY` 从 2 改为 5。

### 任务 1：调整并验证默认并发数

**文件：**
- 修改：`test/task-scheduler.test.mjs:139-146`
- 修改：`server/task-scheduler.mjs:5`

- [ ] **步骤 1：先更新测试期望值**

将默认配置断言从：

```js
assert.deepEqual(resolveSchedulerConfig({ database, processEnv: {} }), {
  concurrency: 2,
  intervalMs: 300_000,
});
```

改为：

```js
assert.deepEqual(resolveSchedulerConfig({ database, processEnv: {} }), {
  concurrency: 5,
  intervalMs: 300_000,
});
```

保留同一测试后半部分对数据库 `scheduler_concurrency` 和环境变量 `TASKBOARD_CONCURRENCY` 优先级的断言。

- [ ] **步骤 2：运行定向测试并确认失败**

运行：

```bash
node --test test/task-scheduler.test.mjs --test-name-pattern="scheduler config falls back to defaults, then settings, then env"
```

预期：FAIL，实际默认 `concurrency` 为 2，而测试期望为 5。

- [ ] **步骤 3：修改最小实现**

将 `server/task-scheduler.mjs` 中：

```js
const DEFAULT_CONCURRENCY = 2;
```

改为：

```js
const DEFAULT_CONCURRENCY = 5;
```

不修改 `resolveSchedulerConfig` 的环境变量、数据库配置或正整数解析逻辑。

- [ ] **步骤 4：运行定向测试并确认通过**

运行：

```bash
node --test test/task-scheduler.test.mjs --test-name-pattern="scheduler config falls back to defaults, then settings, then env"
```

预期：PASS。默认值为 5，数据库设置仍覆盖默认值，环境变量仍覆盖数据库设置。

- [ ] **步骤 5：运行调度器完整测试**

运行：

```bash
node --test test/task-scheduler.test.mjs
```

预期：全部 PASS，无失败、取消或跳过。

- [ ] **步骤 6：运行项目收窄回归测试**

运行：

```bash
node --test $(ls test/*.test.mjs | grep -vE "cloud-|inject|task-editor")
```

预期：全部 PASS，无失败或取消。

- [ ] **步骤 7：提交实现**

```bash
git add server/task-scheduler.mjs test/task-scheduler.test.mjs
git commit -m "fix: 默认 agent 并发数调整为 5"
```

不要提交未跟踪的 `nohup.out` 或 `package.json.orig`。
