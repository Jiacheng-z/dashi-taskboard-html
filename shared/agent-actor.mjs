// agent 写库时的统一身份。id 是 wire 值：parseAssigneeTarget（server/app.mjs:568）校验它，
// 前端发它，历史 tasks/comments/task_activities 行的 actor_id 已经存了它 —— 不能改。
export const AGENT_ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};
