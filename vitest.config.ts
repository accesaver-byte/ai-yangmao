import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Windows 大量并发启动进程会挤占 SQLite/模块加载时间，导致无关测试超时。
  test: { ...(process.platform === 'win32' ? { maxWorkers: 2, testTimeout: 15_000 } : {}) },
});
