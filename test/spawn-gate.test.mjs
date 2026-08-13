import assert from "node:assert/strict";
import test from "node:test";
import { createSpawnGate } from "../server/agent-backends/spawn-gate.mjs";

test("the gate spaces consecutive acquisitions by the requested gap", async () => {
  const gate = createSpawnGate();
  const started = Date.now();
  const stamps = [];
  await Promise.all([1, 2, 3].map(async () => {
    await gate.acquire("ducc", 60);
    stamps.push(Date.now() - started);
  }));
  stamps.sort((left, right) => left - right);
  assert.equal(stamps.length, 3);
  // 第一个立即放行，之后每个至少再等一个 gap
  assert.ok(stamps[1] - stamps[0] >= 55, `gap 1 too small: ${stamps[1] - stamps[0]}`);
  assert.ok(stamps[2] - stamps[1] >= 55, `gap 2 too small: ${stamps[2] - stamps[1]}`);
});

test("a zero gap never waits", async () => {
  const gate = createSpawnGate();
  const started = Date.now();
  await Promise.all([1, 2, 3].map(() => gate.acquire("codex", 0)));
  assert.ok(Date.now() - started < 30, "a zero gap must not introduce delay");
});

test("different backends do not block each other", async () => {
  const gate = createSpawnGate();
  await gate.acquire("ducc", 200);
  const started = Date.now();
  await gate.acquire("codex", 0);
  assert.ok(Date.now() - started < 30, "codex must not wait behind ducc");
});
