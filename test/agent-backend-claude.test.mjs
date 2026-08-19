import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { claudeBackend } from "../server/agent-backends/claude.mjs";
import { duccBackend } from "../server/agent-backends/ducc.mjs";

const THREAD = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  origin: { workspacePath: "/ws" },
  sandbox: "workspace-write",
  model: "claude-sonnet-5",
  reasoningEffort: "high",
  codexThreadId: null,
};

test("claude buildArgs reuses the ducc flags (same function)", () => {
  assert.equal(claudeBackend.buildArgs, duccBackend.buildArgs);
  assert.deepEqual(claudeBackend.buildArgs(THREAD, ["/other"], []), [
    "-p", "--output-format", "stream-json", "--verbose",
    "--session-id", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "--permission-mode", "acceptEdits",
    "--add-dir", "/other",
    "--model", "claude-sonnet-5",
    "--effort", "high",
  ]);
  assert.equal(claudeBackend.needsCwd, true);
  // 官方 claude 没有 bin/ducc 每次启动 sed -i 同一份 settings.json 的并发撞写问题
  assert.equal(claudeBackend.spawnGapMs, 0);
});

test("claude resolveExecutable prefers CLAUDE_EXECUTABLE, then PATH", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-claude-bin-"));
  try {
    const binDirectory = path.join(directory, "bin");
    await mkdir(binDirectory);
    const onPath = path.join(binDirectory, "claude");
    await writeFile(onPath, "#!/bin/sh\nexit 0\n");
    await chmod(onPath, 0o755);

    assert.equal(
      claudeBackend.resolveExecutable({ env: { CLAUDE_EXECUTABLE: " /explicit/claude " } }),
      "/explicit/claude",
    );
    assert.equal(claudeBackend.resolveExecutable({ env: { PATH: binDirectory } }), onPath);
    assert.equal(claudeBackend.resolveExecutable({ env: { PATH: "/nowhere-zzz" } }), "claude");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("claude normalizer is the ducc normalizer (same function)", () => {
  assert.equal(claudeBackend.createNormalizer, duccBackend.createNormalizer);
  const normalize = claudeBackend.createNormalizer();
  assert.deepEqual(normalize({
    type: "system",
    subtype: "init",
    session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  }), { kind: "thread.started", threadId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
});

async function writeSkill(root, name, description) {
  const directory = path.join(root, ".claude", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
  return path.join(directory, "SKILL.md");
}

test("claude discoverCatalog returns static models and scanned skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-claude-catalog-"));
  try {
    const workspacePath = path.join(root, "ws");
    const home = path.join(root, "home");
    await mkdir(workspacePath);
    const repoSkillPath = await writeSkill(workspacePath, "manage-taskboard", "看板任务操作");
    await writeSkill(home, "humanizer", "去掉 AI 味");

    const catalog = await claudeBackend.discoverCatalog({
      workspacePath,
      processEnv: { ...process.env, HOME: home },
    });

    assert.deepEqual(catalog.models.map((model) => model.slug), [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-haiku-4-5-20251001",
      "claude-fable-5",
    ]);
    assert.deepEqual(catalog.models[0], {
      slug: "claude-sonnet-5",
      displayName: "claude-sonnet-5",
      description: "",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
      serviceTiers: [],
    });
    assert.deepEqual(catalog.sandboxes, ["read-only", "workspace-write", "danger-full-access"]);
    assert.deepEqual(catalog.skills.map((skill) => skill.id), ["humanizer", "manage-taskboard"]);
    assert.equal(catalog.skills[1].path, repoSkillPath);
    assert.equal(catalog.skills[1].scope, "repo");
    assert.equal(catalog.skills[0].scope, "user");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claude discoverCatalog lets a repo skill win and tolerates missing directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-claude-catalog-"));
  try {
    const workspacePath = path.join(root, "ws");
    await mkdir(workspacePath);
    const repoSkillPath = await writeSkill(workspacePath, "humanizer", "仓库版");
    const home = path.join(root, "home");
    await writeSkill(home, "humanizer", "用户版");

    const catalog = await claudeBackend.discoverCatalog({
      workspacePath,
      processEnv: { ...process.env, HOME: home },
    });
    assert.equal(catalog.skills.length, 1);
    assert.equal(catalog.skills[0].path, repoSkillPath);
    assert.equal(catalog.skills[0].scope, "repo");

    const empty = await claudeBackend.discoverCatalog({
      workspacePath: root,
      processEnv: { ...process.env, HOME: path.join(root, "nowhere") },
    });
    assert.deepEqual(empty.skills, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
