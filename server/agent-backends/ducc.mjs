export const duccBackend = {
  id: "ducc",
  needsCwd: true,
  // bin/ducc:26-27 每次启动都 sed -i 同一份 settings.json，
  // 并发启动会撞写 → spawn 之间必须错开
  spawnGapMs: 500,
};
