import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");

test("api.ts exposes updateProjectWorkspace that PATCHes the project with workspacePath", () => {
  assert.match(apiSource, /export async function updateProjectWorkspace/);
  const fnMatch = apiSource.match(
    /export async function updateProjectWorkspace[\s\S]*?\n}\n/,
  );
  assert.ok(fnMatch, "updateProjectWorkspace function body not found");
  const fnBody = fnMatch[0];
  assert.match(fnBody, /\/api\/projects\//);
  assert.match(fnBody, /method:\s*"PATCH"/);
  assert.match(fnBody, /workspacePath/);
});

test("App.tsx imports updateProjectWorkspace from ./api", () => {
  assert.match(appSource, /updateProjectWorkspace/);
});

test("App.tsx project context menu has a 设置工作区 / Set workspace item", () => {
  assert.match(appSource, /设置工作区/);
  assert.match(appSource, /Set workspace/);
});

test("App.tsx has workspacePathInput state and calls updateProjectWorkspace(", () => {
  assert.match(appSource, /workspacePathInput/);
  assert.match(appSource, /updateProjectWorkspace\(/);
});
