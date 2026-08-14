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
