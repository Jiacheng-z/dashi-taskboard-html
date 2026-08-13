import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_AGENT_BACKEND, resolveAgentBackend } from "../server/agent-backends/index.mjs";

test("registry defaults to ducc and falls back for unknown ids", () => {
  assert.equal(DEFAULT_AGENT_BACKEND, "ducc");
  assert.equal(resolveAgentBackend("ducc").id, "ducc");
  assert.equal(resolveAgentBackend("codex").id, "codex");
  assert.equal(resolveAgentBackend(null).id, "ducc");
  assert.equal(resolveAgentBackend(undefined).id, "ducc");
  assert.equal(resolveAgentBackend("gemini-whatever").id, "ducc");
});

test("codex adapter builds the same argv it always did", () => {
  const backend = resolveAgentBackend("codex");
  const thread = {
    origin: { workspacePath: "/ws" },
    sandbox: "workspace-write",
    model: "gpt-5.5",
    reasoningEffort: "high",
    codexThreadId: null,
  };
  assert.deepEqual(backend.buildArgs(thread, ["/other"], []), [
    "exec", "--json", "--color", "never",
    "-C", "/ws",
    "-s", "workspace-write",
    "-c", 'approval_policy="on-request"',
    "-c", 'approvals_reviewer="auto_review"',
    "--add-dir", "/other",
    "-m", "gpt-5.5",
    "-c", 'model_reasoning_effort="high"',
    "-",
  ]);
  assert.deepEqual(
    backend.buildArgs({ ...thread, codexThreadId: "codex-1" }, [], []).slice(-3),
    ["resume", "codex-1", "-"],
  );
  assert.equal(backend.needsCwd, false);
  assert.equal(backend.spawnGapMs, 0);
  // 契约要求 createNormalizer() 返回归一化函数；codex 无状态，每次返回同一个
  assert.equal(typeof backend.createNormalizer(), "function");
});

test("codex adapter normalizes events into the shared schema", () => {
  const { normalizeEvent } = resolveAgentBackend("codex");
  assert.deepEqual(normalizeEvent({ type: "thread.started", thread_id: "t-1" }), {
    kind: "thread.started",
    threadId: "t-1",
  });
  const message = normalizeEvent({
    type: "item.completed",
    item: { type: "agent_message", text: "hello" },
  });
  assert.equal(message.kind, "event");
  assert.equal(message.role, "assistant");
  assert.equal(message.content, "hello");
  assert.equal(normalizeEvent({ type: "item.completed", item: { type: "reasoning", text: "x" } }), null);
});
