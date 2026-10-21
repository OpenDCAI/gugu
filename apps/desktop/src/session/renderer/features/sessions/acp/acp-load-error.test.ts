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
