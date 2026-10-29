/**
 * #6264 把账号进程的本机套接字接到会话页引擎上(连接处理与协议在 attach-server.ts / attach-protocol.ts)。
 * 只有 server 模式调它:设备连接(link)与这台机器上的程序「打开网页」(call)走这里。
 */
import { log } from '@main/lib/logger';
import { installServerBrowserHelpers } from '../server-browser-env';
import { startPtyAttachServer, type AttachDeps } from './attach-server';
import { HOST_RESUME_CALL, OPEN_EXTERNAL_CALL, VERSION_HANDOFF_CALL } from './attach-protocol';

/**
 * #6264 这台机器上的程序要「打开网页」:装上助手脚本(`$BROWSER` / xdg-open),之后起的 agent 与终端都带上;
 * 脚本经这个套接字把网址交回来(remote-open-external.ts)。装不上只少了这一样,响亮记一笔、不挡别的。
 */
function installBrowserHelpers(): void {
  const serverHome = process.env.GUGU_SERVER_HOME;
  const account = process.env.GUGU_SERVER_ACCOUNT;
  if (!serverHome || !account) return;
  try {
    const dir = installServerBrowserHelpers({
      serverHome,
      account,
      fallbackLauncher: [process.execPath, ...(process.argv[1] ? [process.argv[1]] : [])],
    });
    log.info('server: browser helpers installed', { dir });
  } catch (error) {
    log.warn('server: browser helpers could not be installed — pages opened by programs here stay on this machine', {
      error: String(error),
    });
  }
}

/**
 * @param options.link 设备连接(远程 SSH 的机器上桌面与它之间的一切):由主进程装配 —— 它手里有与云端设备 RPC
 *   同一张处理表(经会话页桥建),这里只负责把连接交给它。不给 = 不接设备连接。
 */
export function startSessionPtyAttachServer(dataDir: string, options: { link?: AttachDeps['link']; resume?: (suspendedSince?: number) => void; timeZone?: (context: unknown) => void; handoff?: (payload: unknown) => Promise<unknown> } = {}) {
  installBrowserHelpers();
  return startPtyAttachServer(dataDir, {
    warn: (message, fields) => log.warn(message, fields),
    // 一问一答只接这台机器上的程序「打开网页」(只走本机套接字);桌面与这台机器之间的一切走设备连接(link)。
    call: async (type, payload) => {
      if (type === VERSION_HANDOFF_CALL && options.handoff) return options.handoff(payload);
      if (type === HOST_RESUME_CALL && options.resume) {
        const since = payload && typeof payload === 'object' ? (payload as { suspendedSince?: unknown }).suspendedSince : undefined;
        if (since !== undefined && (typeof since !== 'number' || !Number.isSafeInteger(since) || since <= 0 || since >= Date.now())) {
          return { error: { code: 'invalid_interval', message: 'The confirmed suspension start must precede this resume' } };
        }
        const context = payload && typeof payload === 'object' ? (payload as { timeZoneContext?: unknown }).timeZoneContext : undefined;
        if (context !== undefined) {
          if (!options.timeZone) return { error: { code: 'unsupported_context', message: 'This account cannot apply a time-zone context' } };
          try { options.timeZone(context); } catch (error) {
            return { error: { code: 'invalid_context', message: error instanceof Error ? error.message : String(error) } };
          }
        }
        options.resume(since as number | undefined);
        return { result: { resumed: true, pid: process.pid } };
      }
      if (type === OPEN_EXTERNAL_CALL) {
        const { answerOpenExternalCall } = await import('../../session-timeline/remote-open-external-wiring');
        return answerOpenExternalCall(payload);
      }
      return { error: { code: 'unsupported_call', message: `not answered over this socket: ${type}` } };
    },
    ...(options.link ? { link: options.link } : {}),
  });
}
