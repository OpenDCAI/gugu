import type { HostIpcMain } from './host-ipc';
import { log } from './logger';

/**
 * 参数里带秘密的调用(直连终端回答 ssh 的密码 / 口令):开发日志里只记通道名,❌ 把密码写进日志。
 */
const SECRET_ARG_CHANNELS = /(?:^|[.:])answerPrompt$/;

export function redactRpcArgs(channel: string, args: unknown[]): unknown[] {
  return SECRET_ARG_CHANNELS.test(channel) ? ['[redacted]'] : args;
}

export function withRpcLogging(target: HostIpcMain): HostIpcMain {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop !== 'handle') return Reflect.get(obj, prop, receiver);
      return (channel: string, handler: (...a: unknown[]) => unknown) =>
        obj.handle(channel, async (event, ...args: unknown[]) => {
          try {
            const result = await handler(event, ...args);
            log.debug('rpc result', { channel, args: redactRpcArgs(channel, args), result });
            return result;
          } catch (err) {
            log.error('rpc error', { channel, args: redactRpcArgs(channel, args), err });
            throw err;
          }
        });
    },
  });
}
