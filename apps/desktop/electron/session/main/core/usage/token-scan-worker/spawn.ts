import { Worker } from 'node:worker_threads';
import { desktopWorkerPath } from '@main/worker-manifest';
import type { TokenScanWorkerLike } from '../token-scan-client';

/**
 * 起用量页 token 扫描的 worker 线程。入口是构建产物 dist-electron/usage-token-scan.js
 * (与 acp-runtime.js 等同一次 lib 构建的入口,登记在 worker-manifest.ts 与 emdash-aliases.mjs)。
 * 单独一个文件,单测据此把它换成进程内实现。
 */
export function spawnTokenScanWorker(): TokenScanWorkerLike {
  return new Worker(desktopWorkerPath('usage-token-scan'), { name: 'usage-token-scan' }) as unknown as TokenScanWorkerLike;
}
