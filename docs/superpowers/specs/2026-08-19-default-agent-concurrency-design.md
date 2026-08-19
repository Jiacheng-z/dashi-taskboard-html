# 默认 Agent 并发数调整设计

## 背景

任务自动化调度器当前在没有显式配置时默认最多并发运行 2 个 Agent 任务。目标是将这个默认值调整为 5。

## 范围

仅调整调度器的默认并发常量：

- 文件：`server/task-scheduler.mjs`
- 当前值：`DEFAULT_CONCURRENCY = 2`
- 目标值：`DEFAULT_CONCURRENCY = 5`

不改变显式配置行为。并发配置的优先级继续保持：

1. 环境变量 `TASKBOARD_CONCURRENCY`
2. 数据库设置 `scheduler_concurrency`
3. 默认值 5

因此，已有环境变量或数据库设置的部署不会因为本次变更被覆盖。

## 验证

验证 `resolveSchedulerConfig` 在没有显式配置时返回 `concurrency: 5`，并确认以下行为不变：

- 有效的环境变量仍优先于数据库设置和默认值。
- 数据库设置仍优先于默认值。
- 无效配置仍回退到默认值 5。

运行项目已有的相关测试及 TypeScript/构建检查。
