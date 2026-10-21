import { foldTokenEntries } from '../token-fold';
import { TOKEN_LOG_READERS } from '../token-readers/registry';
import type { TokenLogReader } from '../token-readers/types';
import { collectTokenEntries, createParsedFileMemory, hydrateParsedFileMemory } from '../token-scan';
import type { FromWorker, ToWorker } from './protocol';

/**
 * worker 线程里的那一半,与线程本身解耦(入口 `entry.ts` 只把 parentPort 接到这里),
 * 所以单测可以在进程内直接驱动它。
 *
 * ⚠️ 这张 import 图只许用相对路径、只许到 node 内建与本目录的纯模块:它会被构建成独立入口在
 * worker 线程里跑,❌ 引进 `@main/db/client`、logger 这类「import 即初始化」的主进程单例。
 */
export function createTokenScanService(
  send: (message: FromWorker) => void,
  readers: readonly TokenLogReader[] = TOKEN_LOG_READERS
): { handle(message: ToWorker): Promise<void> } {
  const memory = createParsedFileMemory();
  return {
    async handle(message) {
      if (message.type === 'hydrate') {
        // 缓存只是省事,不是真相:载不进来(脏行、将来改了格式)就当没缓存,那几份日志下次扫描时重读。
        // ❌ 不让它抛:这里一抛,后面的 scan 请求就等不到回话了。
        try {
          hydrateParsedFileMemory(memory, message.rows);
        } catch (error) {
          send({ type: 'file-error', path: '<token cache>', error: String(error) });
        }
        return;
      }
      try {
        const { entries, stats } = await collectTokenEntries({
          providerSessions: message.providerSessions,
          readers,
          rootsByProvider: message.rootsByProvider,
          memory,
          onSave: (row) => send({ type: 'save', row }),
          onFileError: (path, error) => send({ type: 'file-error', path, error: String(error) }),
        });
        send({ type: 'result', id: message.id, rows: foldTokenEntries(entries, message.sourcesByProviderSession), stats });
      } catch (error) {
        send({ type: 'failed', id: message.id, error: error instanceof Error ? error.stack ?? error.message : String(error) });
      }
    },
  };
}
