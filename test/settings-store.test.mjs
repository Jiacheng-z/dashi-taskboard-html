import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

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

test("settings store upserts by key and returns null for unknown keys", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-settings-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  try {
    assert.equal(database.getSetting("agent_backend"), null);

    assert.equal(database.setSetting("agent_backend", "ducc"), "ducc");
    assert.equal(database.getSetting("agent_backend"), "ducc");

    assert.equal(database.setSetting("agent_backend", "codex"), "codex");
    assert.equal(database.getSetting("agent_backend"), "codex");
    assert.equal(
      database.database.prepare("SELECT COUNT(*) AS total FROM settings").get().total,
      1,
    );

    const row = database.database
      .prepare("SELECT updated_at FROM settings WHERE key = 'agent_backend'").get();
    assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
