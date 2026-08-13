import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { duccBackend } from "../server/agent-backends/ducc.mjs";

const MODELS_OUTPUT = "Available Models:\nauto, GLM-5, Claude Opus 4.6, Opus 5, Fable 5\n";

async function writeSkill(root, name, description) {
  const directory = path.join(root, ".claude", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
  return path.join(directory, "SKILL.md");
}

test("ducc discoverCatalog parses `ducc models` text and scans SKILL.md", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-ducc-catalog-"));
  try {
    const executable = path.join(root, "fake-ducc");
    await writeFile(executable, `#!/bin/sh\nprintf '%s' '${MODELS_OUTPUT}'\n`);
    await chmod(executable, 0o755);

    const workspacePath = path.join(root, "ws");
    const home = path.join(root, "home");
    await mkdir(workspacePath);
    const repoSkillPath = await writeSkill(workspacePath, "manage-taskboard", "看板任务操作");
    await writeSkill(home, "humanizer", "去掉 AI 味");

    const catalog = await duccBackend.discoverCatalog({
      executable,
      workspacePath,
      processEnv: { ...process.env, HOME: home },
    });

    assert.equal(catalog.models[0].slug, "Opus 5");
    assert.deepEqual(catalog.models[0].supportedReasoningEfforts, ["low", "medium", "high", "max"]);
    assert.equal(catalog.models[0].defaultReasoningEffort, "medium");
    assert.equal(catalog.models.length, 5);
    assert.deepEqual(catalog.sandboxes, ["read-only", "workspace-write", "danger-full-access"]);

    assert.deepEqual(catalog.skills.map((skill) => skill.id), ["humanizer", "manage-taskboard"]);
    assert.deepEqual(catalog.skills[1], {
      id: "manage-taskboard",
      label: "manage-taskboard",
      description: "看板任务操作",
      path: repoSkillPath,
      scope: "repo",
    });
    assert.equal(catalog.skills[0].scope, "user");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ducc discoverCatalog lets a repo skill win and tolerates missing directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-ducc-catalog-"));
  try {
    const executable = path.join(root, "fake-ducc");
    await writeFile(executable, `#!/bin/sh\nprintf '%s' '${MODELS_OUTPUT}'\n`);
    await chmod(executable, 0o755);

    const workspacePath = path.join(root, "ws");
    await mkdir(workspacePath);
    const repoSkillPath = await writeSkill(workspacePath, "humanizer", "仓库版");
    const home = path.join(root, "home");
    await writeSkill(home, "humanizer", "用户版");

    const catalog = await duccBackend.discoverCatalog({
      executable,
      workspacePath,
      processEnv: { ...process.env, HOME: home },
    });
    assert.equal(catalog.skills.length, 1);
    assert.equal(catalog.skills[0].path, repoSkillPath);
    assert.equal(catalog.skills[0].scope, "repo");

    // 两个 .claude/skills 都不存在时返回空数组，不抛
    const empty = await duccBackend.discoverCatalog({
      executable,
      workspacePath: root,
      processEnv: { ...process.env, HOME: path.join(root, "nowhere") },
    });
    assert.deepEqual(empty.skills, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
