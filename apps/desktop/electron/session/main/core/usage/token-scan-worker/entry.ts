import { openTokenCachePager } from './sqlite-cache';
import type { TokenCachePager } from '../token-scan-client';
import { parentPort, workerData } from 'node:worker_threads';
import type { ToWorker } from './protocol';
import { createTokenScanService } from './service';

// 用量页 token 扫描的 worker 线程入口(见 protocol.ts 的抬头)。构建成 dist-electron/usage-token-scan.js,
// 由 token-scan-client.ts 用 worker_threads 起。消息逐条串行处理:hydrate 必须先于 scan 落进内存层。
const port = parentPort;
if (!port) throw new Error('usage-token-scan: must run inside a worker thread');

let cache: (TokenCachePager & { close?(): void }) | undefined;
if (typeof workerData?.cacheDbPath === 'string') {
  try { cache = openTokenCachePager(workerData.cacheDbPath); }
  catch (error) {
    port.postMessage({ type: 'cache-error', path: '<token cache>', error: String(error) });
    // Disposable cache failure must not drop usage or forward bulk writes to main.
    cache = { loadPage: () => [], save: () => {} };
  }
}
port.on('close', () => cache?.close?.());
const service = createTokenScanService((message) => port.postMessage(message), undefined, cache);
let queue: Promise<void> = Promise.resolve();
port.on('message', (message: ToWorker) => {
  // 兜底:任何一条消息失败都不许把队列留在 rejected —— 否则之后的每条消息(包括 scan)都被静默跳过,
  // 主线程那边的请求永远等不到回话。
  queue = queue.then(() => service.handle(message)).catch((error: unknown) => {
    if (message.type === 'scan') port.postMessage({ type: 'failed', id: message.id, error: String(error) });
  });
});
