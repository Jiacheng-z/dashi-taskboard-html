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

test("claude buildArgs reuses the ducc flags (same function), including --model", () => {
  // claude 和 ducc 同一个 base-url（oneapi），界面选的模型名直接原样传给 CLI
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

test("claude discoverCatalog spawns `ducc models` (same source as ducc backend) and scans skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-claude-catalog-"));
  try {
    const workspacePath = path.join(root, "ws");
    const home = path.join(root, "home");
    await mkdir(workspacePath);
    const repoSkillPath = await writeSkill(workspacePath, "manage-taskboard", "看板任务操作");
    await writeSkill(home, "humanizer", "去掉 AI 味");

    const binDirectory = path.join(root, "bin");
    await mkdir(binDirectory);
    const duccExecutable = path.join(binDirectory, "ducc");
    await writeFile(
      duccExecutable,
      "#!/bin/sh\necho 'Available Models:'\necho 'Claude Sonnet 5, Opus 5, DeepSeek-V4-Flash'\n",
    );
    await chmod(duccExecutable, 0o755);

    const catalog = await claudeBackend.discoverCatalog({
      workspacePath,
      processEnv: { ...process.env, HOME: home, PATH: binDirectory },
    });

    // 模型目录来自 `ducc models`，和 ducc 后端读到的是同一份名字（同 base-url）。
    // parseDuccModels 会把 DUCC_PREFERRED_MODEL("Opus 5") 顶到第一位。
    assert.deepEqual(catalog.models.map((model) => model.slug), [
      "Opus 5",
      "Claude Sonnet 5",
      "DeepSeek-V4-Flash",
    ]);
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
