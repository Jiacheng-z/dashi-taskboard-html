import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { duccBackend } from "../server/agent-backends/ducc.mjs";

const THREAD = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  origin: { workspacePath: "/ws" },
  sandbox: "workspace-write",
  model: "Opus 5",
  reasoningEffort: "high",
  codexThreadId: null,
};

test("ducc buildArgs pins the session id and keeps the prompt off argv", () => {
  assert.deepEqual(duccBackend.buildArgs(THREAD, ["/other"], []), [
    "-p", "--output-format", "stream-json", "--verbose",
    "--session-id", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "--permission-mode", "acceptEdits",
    "--add-dir", "/other",
    "--model", "Opus 5",
    "--effort", "high",
  ]);
  assert.equal(duccBackend.needsCwd, true);
  assert.equal(duccBackend.spawnGapMs, 500);
});

test("ducc buildArgs resumes by session id instead of pinning a new one", () => {
  const args = duccBackend.buildArgs(
    { ...THREAD, codexThreadId: "11111111-2222-3333-4444-555555555555" }, [], [],
  );
  assert.equal(args.includes("--session-id"), false);
  assert.deepEqual(args.slice(4, 6), ["--resume", "11111111-2222-3333-4444-555555555555"]);
});

test("ducc buildArgs omits a non-uuid session id", () => {
  const args = duccBackend.buildArgs({ ...THREAD, id: "not-a-uuid" }, [], []);
  assert.equal(args.includes("--session-id"), false);
});

test("ducc buildArgs maps sandbox onto permission modes", () => {
  const readOnly = duccBackend.buildArgs({ ...THREAD, sandbox: "read-only" }, [], []);
  assert.deepEqual(readOnly.slice(6, 10), [
    "--permission-mode", "default", "--disallowedTools", "Write,Edit,NotebookEdit",
  ]);
  const danger = duccBackend.buildArgs({ ...THREAD, sandbox: "danger-full-access" }, [], []);
  assert.deepEqual(danger.slice(6, 8), ["--permission-mode", "bypassPermissions"]);
});

test("ducc resolveExecutable prefers DUCC_EXECUTABLE, then PATH", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ducc-bin-"));
  try {
    const binDirectory = path.join(directory, "bin");
    await mkdir(binDirectory);
    const onPath = path.join(binDirectory, "ducc");
    await writeFile(onPath, "#!/bin/sh\nexit 0\n");
    await chmod(onPath, 0o755);

    assert.equal(
      duccBackend.resolveExecutable({ env: { DUCC_EXECUTABLE: " /explicit/ducc " } }),
      "/explicit/ducc",
    );
    assert.equal(duccBackend.resolveExecutable({ env: { PATH: binDirectory } }), onPath);
    assert.equal(duccBackend.resolveExecutable({ env: { PATH: "/nowhere-zzz" } }), "ducc");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
