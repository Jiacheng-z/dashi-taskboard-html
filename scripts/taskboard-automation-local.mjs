#!/usr/bin/env node
// 本地自动化循环：定时敲一次服务端调度接口。
// 真正的「取任务 → 建会话 → 跑 agent → 收尾」全在 server/task-scheduler.mjs 里，
// 这里不 spawn agent、不碰 taskctl，也不持有任何会话 id
// （旧版整个进程共用一个 threadId，导致所有任务串到同一个会话上）。
const baseUrl = (process.env.CODEX_TASKBOARD_URL ?? "http://127.0.0.1:47823").replace(/\/+$/, "");
const interval = Number(process.env.TASKBOARD_INTERVAL_MS ?? 300_000);

if (!Number.isFinite(interval) || interval < 0) {
  throw new Error("TASKBOARD_INTERVAL_MS must be a non-negative number");
}

async function tick() {
  const response = await fetch(`${baseUrl}/api/local/ai/scheduler/tick`, { method: "POST" });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`tick failed with ${response.status}: ${text}`);
  }
  const body = JSON.parse(text);
  console.log(
    `[taskboard] started=${body.started} concurrency=${body.concurrency} intervalMs=${body.intervalMs}`,
  );
}

do {
  try {
    await tick();
  } catch (error) {
    // 服务没起来、正在重启都会走到这里；不退出，下一轮再试
    console.error(`[taskboard] ${error.message}`);
  }
  if (interval > 0) await new Promise((resolve) => setTimeout(resolve, interval));
} while (interval > 0);
