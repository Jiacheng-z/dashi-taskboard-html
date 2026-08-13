import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

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
