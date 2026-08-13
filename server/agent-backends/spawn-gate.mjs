const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 按后端 id 分别排队的启动闸门。
 * 起因：`bin/ducc:26-27` 每次启动都对同一份 settings.json 做 sed -i，
 * 并发启动会撞写（规格 §5.6）。外部脚本改不了，只能让我们自己错开。
 */
export function createSpawnGate() {
  // backend id → 下一次最早可以 spawn 的时刻（epoch ms）
  const nextAllowedAt = new Map();
  return {
    async acquire(backendId, gapMs) {
      if (!gapMs) return;
      const now = Date.now();
      const earliest = Math.max(now, nextAllowedAt.get(backendId) ?? 0);
      // 先把下一位的时刻占掉再 await，否则同一 tick 里进来的几个人会算出同一个 earliest
      nextAllowedAt.set(backendId, earliest + gapMs);
      if (earliest > now) await sleep(earliest - now);
    },
  };
}

// server 进程内共享一个：跨 thread 的 spawn 也要互相错开
export const spawnGate = createSpawnGate();
