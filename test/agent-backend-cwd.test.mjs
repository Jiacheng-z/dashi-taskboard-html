import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { spawnCodexTurn } from "../server/ai-chat-process.mjs";

test("spawnCodexTurn runs the executable in the requested cwd", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-cwd-"));
  try {
    const workspace = await realpath(await mkdir(path.join(directory, "ws"), { recursive: true })
      .then(() => path.join(directory, "ws")));
    const capturePath = path.join(directory, "cwd.txt");
    const executable = path.join(directory, "fake-cwd.mjs");
    await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_CWD_PATH, process.cwd());
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`);
    await chmod(executable, 0o755);

    const { completion } = spawnCodexTurn({
      executable,
      args: [],
      prompt: "",
      cwd: workspace,
      env: { ...process.env, FAKE_CWD_PATH: capturePath },
      onRawEvent: () => {},
    });
    await completion;

    assert.equal((await readFile(capturePath, "utf8")).trim(), workspace);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
