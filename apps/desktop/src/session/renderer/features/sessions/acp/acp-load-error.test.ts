import { describe, expect, it } from 'vitest';
import { AcpStartError } from '@renderer/lib/acp/acp-live-session';
import { toLoadError } from './acp-load-error';

const spawnFailed = (cause: Record<string, unknown>) =>
  new AcpStartError({ type: 'spawn_failed', cause } as never);

/**
 * 10-07 资源库体检:Hermes 0.21.0 起聊天腿,界面只有一行被截断的英文。版本闸的两个数现在原样带过运行时
 * (`source.ts` 放在 spawn_failed 的 `cause.data`),这里把它们读成 `runtime_upgrade`。
 */
describe('toLoadError — 版本低于下界', () => {
  it('cause 带 runtime-version-unsupported 与两个数:runtime_upgrade', () => {
    const error = toLoadError(spawnFailed({
      name: 'Error',
      message: 'hermes acp requires harness runtime 0.21.5 or newer; found 0.21.0',
      code: 'runtime-version-unsupported',
      data: { installedVersion: '0.21.0', supportedFloor: '0.21.5', executable: '/u/.local/bin/hermes' },
    }));
    expect(error).toMatchObject({ kind: 'runtime_upgrade', installedVersion: '0.21.0', supportedFloor: '0.21.5' });
  });

  it('同一个 code 但没带数(读不出版本):照旧是 generic,❌ 编一句「要升到几」', () => {
    const error = toLoadError(spawnFailed({ name: 'Error', message: 'x', code: 'runtime-version-unsupported' }));
    expect(error.kind).toBe('generic');
  });
});

/**
 * 2026-10-27 owner 重启咕咕:开机时到 d22 的线换通道,在途的起会话被拒成 `Wire transport disconnected`,
 * 界面说成「引擎没能启动」。线断了的失败要按「线断了」认 —— 只认别的机器上的会话(本机会话没有那条线)。
 */
describe('toLoadError — 到那台机器的线断了', () => {
  const disconnected = Object.assign(new Error('Wire transport disconnected'), { name: 'WireError', code: 'DISCONNECTED' });

  it('别的机器上的会话,wire 断开:connection_lost,带上是哪台机器', () => {
    expect(toLoadError(disconnected, 'device-d22')).toEqual({
      kind: 'connection_lost',
      message: 'Wire transport disconnected',
      deviceId: 'device-d22',
    });
  });

  it('那台机器此刻够不着(开线当场被拒,code unreachable):同样是 connection_lost', () => {
    const unreachable = Object.assign(new Error('此刻连不上「d22」。'), { code: 'unreachable' });
    expect(toLoadError(unreachable, 'device-d22').kind).toBe('connection_lost');
  });

  it('本机会话:照旧 generic(没有那条线可等)', () => {
    expect(toLoadError(disconnected).kind).toBe('generic');
  });

  it('别的 wire 错误(不是断开):照旧 generic', () => {
    const timeout = Object.assign(new Error('Wire call timed out'), { name: 'WireError', code: 'TIMEOUT' });
    expect(toLoadError(timeout, 'device-d22').kind).toBe('generic');
  });
});
