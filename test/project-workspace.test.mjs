import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer(configure, listenOptions = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-test-"));
  const options = configure ? await configure(directory) : {};
  const app = createTaskboardServer({ dataDirectory: directory, ...options });
  const address = await app.listen({ port: 0, ...listenOptions });
  runningApps.push({ app, directory });
  return `http://127.0.0.1:${address.port}`;
}

async function request(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined || typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : undefined,
  };
}

test("PATCH /api/projects/:id writes and persists workspace_path", async () => {
  const baseUrl = await startServer();

  const created = await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "p1", name: "P1", workspacePath: null },
  });
  assert.equal(created.response.status, 201);

  const patched = await request(baseUrl, "/api/projects/p1", {
    method: "PATCH",
    body: { workspacePath: "/tmp/some-workspace" },
  });
  assert.equal(patched.response.status, 200);
  assert.equal(patched.body.project.workspacePath, "/tmp/some-workspace");

  const listed = await request(baseUrl, "/api/projects");
  assert.equal(listed.response.status, 200);
  const p1 = listed.body.projects.find((project) => project.id === "p1");
  assert.equal(p1.workspacePath, "/tmp/some-workspace");

  const cleared = await request(baseUrl, "/api/projects/p1", {
    method: "PATCH",
    body: { workspacePath: null },
  });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.body.project.workspacePath, null);

  const rejected = await request(baseUrl, "/api/projects/p1", {
    method: "PATCH",
    body: { workspacePath: "relative/path" },
  });
  assert.equal(rejected.response.status, 400);

  const notFound = await request(baseUrl, "/api/projects/nope", {
    method: "PATCH",
    body: { workspacePath: "/tmp/some-workspace" },
  });
  assert.equal(notFound.response.status, 404);
});
