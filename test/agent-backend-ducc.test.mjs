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

const INIT_EVENT = {
  type: "system",
  subtype: "init",
  cwd: "/tmp/ws",
  session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  model: "Opus 5",
  permissionMode: "acceptEdits",
  claude_code_version: "2.1.76",
};

test("ducc normalizer maps system/init to thread.started and drops hook noise", () => {
  const normalize = duccBackend.createNormalizer();
  assert.deepEqual(normalize(INIT_EVENT), {
    kind: "thread.started",
    threadId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  });
  assert.equal(normalize({ type: "system", subtype: "hook_started" }), null);
  assert.equal(normalize({ type: "system", subtype: "hook_response", exit_code: 0 }), null);
  assert.equal(normalize({ type: "system", subtype: "init" }), null);
  assert.equal(normalize(null), null);
  assert.equal(normalize([]), null);
});

test("ducc normalizer splits one assistant message into per-block events", () => {
  const normalize = duccBackend.createNormalizer();
  const events = normalize({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "先看文件" },
        { type: "thinking", thinking: "内部推理，不入库" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/ws/a.txt" } },
        { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls -l" } },
      ],
    },
    session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  });
  assert.equal(events.length, 3);
  assert.deepEqual(events[0], {
    kind: "event",
    type: "agent_message",
    role: "assistant",
    content: "先看文件",
    data: { status: "completed" },
  });
  assert.deepEqual(events[1], {
    kind: "event",
    type: "mcp_tool_call",
    role: "activity",
    content: "Read",
    data: {
      status: "started",
      itemId: "toolu_1",
      tool: "Read",
      detail: JSON.stringify({ arguments: { file_path: "/tmp/ws/a.txt" } }),
    },
  });
  assert.deepEqual(events[2], {
    kind: "event",
    type: "command_execution",
    role: "activity",
    content: "ls -l",
    data: { status: "started", itemId: "toolu_2", command: "ls -l" },
  });
});

test("ducc normalizer replays the tool_use type on its tool_result", () => {
  const normalize = duccBackend.createNormalizer();
  normalize({
    type: "assistant",
    message: { content: [
      { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls -l" } },
    ] },
  });
  const [result] = normalize({
    type: "user",
    message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_2", content: "total 0\n" },
    ] },
  });
  // type 必须与 tool_use 那条一致，否则 filterVisibleAiEvents 的 itemId 去重会换掉卡片类型
  assert.deepEqual(result, {
    kind: "event",
    type: "command_execution",
    role: "activity",
    content: "ls -l",
    data: { status: "completed", itemId: "toolu_2", command: "ls -l", output: "total 0\n" },
  });
});

test("ducc normalizer maps write tools onto file_change", () => {
  const normalize = duccBackend.createNormalizer();
  const [started] = normalize({
    type: "assistant",
    message: { content: [
      { type: "tool_use", id: "toolu_3", name: "Edit",
        input: { file_path: "/tmp/ws/b.txt", old_string: "a", new_string: "b" } },
    ] },
  });
  assert.deepEqual(started, {
    kind: "event",
    type: "file_change",
    role: "activity",
    content: "/tmp/ws/b.txt",
    data: { status: "started", itemId: "toolu_3", files: ["/tmp/ws/b.txt"] },
  });
});

test("ducc normalizer marks a failed tool_result as an error", () => {
  const normalize = duccBackend.createNormalizer();
  // 没见过对应的 tool_use（比如 resume 续上的会话）→ 落回 mcp_tool_call
  const [failed] = normalize({
    type: "user",
    message: { content: [
      { type: "tool_result", tool_use_id: "toolu_9", content: "boom", is_error: true },
    ] },
  });
  assert.equal(failed.type, "mcp_tool_call");
  assert.equal(failed.role, "error");
  assert.equal(failed.data.status, "failed");
  assert.equal(failed.data.detail, JSON.stringify({ result: "boom" }));
});

test("ducc normalizer ignores a user turn that carries no tool_result", () => {
  const normalize = duccBackend.createNormalizer();
  assert.equal(normalize({ type: "user", message: { content: "纯文本回声" } }), null);
});

test("ducc normalizer turns the result event into a terminal outcome", () => {
  const normalize = duccBackend.createNormalizer();
  assert.deepEqual(normalize({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "hello",
    usage: { input_tokens: 94529, cache_read_input_tokens: 12, output_tokens: 19 },
  }), {
    kind: "event",
    type: "turn.completed",
    role: "activity",
    // 终态不重复正文：result 里那段文字前面已经作为 assistant text 块入过库
    content: "",
    data: {
      status: "completed",
      usage: { input_tokens: 94529, cached_input_tokens: 12, output_tokens: 19 },
    },
    outcome: "completed",
  });
});

test("ducc normalizer reports a failed result as turn.failed", () => {
  const normalize = duccBackend.createNormalizer();
  assert.deepEqual(normalize({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "配额用尽",
  }), {
    kind: "event",
    type: "turn.failed",
    role: "error",
    content: "配额用尽",
    data: { status: "failed" },
    outcome: "failed",
  });
});
