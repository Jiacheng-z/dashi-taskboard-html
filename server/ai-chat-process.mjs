import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { withoutTaskboardLauncherEnvironment } from "../shared/codex-environment.mjs";
// 三个函数已搬到 codex adapter；这里 re-export 只为不改动既有 import 点
// （server/ai-chat.mjs、test/ai-chat-runner.test.mjs）
export {
  buildCodexArgs,
  buildCodexPrompt,
  normalizeCodexEvent,
} from "./agent-backends/codex.mjs";

const STDERR_LIMIT = 65_536;
const TURN_OWNER_PATH = fileURLToPath(new URL("./ai-turn-owner.mjs", import.meta.url));

export function spawnCodexTurn({
  executable,
  args,
  prompt,
  env,
  cwd,
  onRawEvent,
  maxLineBytes = 1_048_576,
}) {
  const child = spawn(
    process.execPath,
    [TURN_OWNER_PATH, executable, JSON.stringify(args), cwd ?? ""],
    {
      detached: true,
      env: withoutTaskboardLauncherEnvironment(env),
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );

  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = Buffer.alloc(0);
  let settled = false;
  let fatalError = null;
  let stdoutEnded = false;
  let resolveCompletion;
  let rejectCompletion;

  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  function terminateProcessGroup() {
    if (Number.isInteger(child.pid)) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {}
    }
    child.kill("SIGKILL");
  }

  function rejectWithDiagnostic(error) {
    if (settled || fatalError) return;
    fatalError = error instanceof Error ? error : new Error(String(error));
    terminateProcessGroup();
  }

  function consumeLine(line) {
    if (fatalError) return;
    if (line.length > maxLineBytes) {
      rejectWithDiagnostic(new Error(`Codex JSONL line exceeded ${maxLineBytes} bytes`));
      return;
    }
    if (line.at(-1) === 13) line = line.subarray(0, -1);
    if (line.toString("utf8").trim() === "") return;
    let raw;
    try {
      raw = JSON.parse(line.toString("utf8"));
    } catch {
      rejectWithDiagnostic(new Error("Codex emitted malformed JSONL"));
      return;
    }
    try {
      onRawEvent(raw);
    } catch (error) {
      rejectWithDiagnostic(error);
    }
  }

  function consumeChunk(chunk) {
    if (settled) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length && !settled && !fatalError) {
      const newline = bytes.indexOf(10, offset);
      if (newline === -1) {
        const remainder = bytes.subarray(offset);
        if (stdoutBuffer.length + remainder.length > maxLineBytes) {
          rejectWithDiagnostic(new Error(`Codex JSONL line exceeded ${maxLineBytes} bytes`));
          return;
        }
        stdoutBuffer = stdoutBuffer.length === 0
          ? Buffer.from(remainder)
          : Buffer.concat([stdoutBuffer, remainder]);
        return;
      }
      const segment = bytes.subarray(offset, newline);
      if (stdoutBuffer.length + segment.length > maxLineBytes) {
        rejectWithDiagnostic(new Error(`Codex JSONL line exceeded ${maxLineBytes} bytes`));
        return;
      }
      const line = stdoutBuffer.length === 0
        ? segment
        : Buffer.concat([stdoutBuffer, segment]);
      stdoutBuffer = Buffer.alloc(0);
      consumeLine(line);
      offset = newline + 1;
    }
  }

  function finishStdout() {
    if (stdoutEnded) return;
    stdoutEnded = true;
    if (!fatalError && stdoutBuffer.length > 0) {
      const line = stdoutBuffer;
      stdoutBuffer = Buffer.alloc(0);
      consumeLine(line);
    }
  }

  child.stdout.on("data", consumeChunk);
  child.stdout.on("end", finishStdout);
  child.stderr.on("data", (chunk) => {
    if (stderrBuffer.length >= STDERR_LIMIT) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderrBuffer = Buffer.concat([
      stderrBuffer,
      bytes.subarray(0, STDERR_LIMIT - stderrBuffer.length),
    ]);
  });
  child.on("error", rejectWithDiagnostic);
  child.on("exit", () => child.stdio[3].destroy());
  child.on("close", (exitCode, signal) => {
    finishStdout();
    if (settled) return;
    settled = true;
    if (fatalError) {
      if (stderrBuffer.length > 0) {
        fatalError.stderr = stderrBuffer.toString("utf8");
      }
      rejectCompletion(fatalError);
      return;
    }
    resolveCompletion({ exitCode, signal });
  });
  child.stdin.on("error", () => {});
  child.stdio[3].on("error", () => {});
  child.stdin.end(prompt);

  return { child, completion };
}
