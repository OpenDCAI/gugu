import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@gugu/session-shared';
import { createLocalInstallCommandRunner } from './install-runner';

const mocks = vi.hoisted(() => ({
  runMiseOperation: vi.fn(),
}));

vi.mock('./mise-installer', () => ({ runMiseOperation: mocks.runMiseOperation }));

beforeEach(() => {
  vi.clearAllMocks();
});

const miseContext = {
  mise: {
    target: {
      kind: 'mise' as const,
      package: '@openai/codex',
      binary: 'codex',
      backend: {
        kind: 'platform-archive' as const,
        executables: { 'darwin-arm64': 'vendor/aarch64-apple-darwin/bin/codex' },
      },
    },
    operation: 'install' as const,
  },
};

describe('createLocalInstallCommandRunner', () => {
  it('routes a managed install to the bundled installer', async () => {
    mocks.runMiseOperation.mockResolvedValueOnce(ok(undefined));

    const result = await createLocalInstallCommandRunner()('mise install http:gugu-codex', miseContext);

    expect(result.success).toBe(true);
    expect(mocks.runMiseOperation).toHaveBeenCalledWith(miseContext);
  });

  it('装法只剩托管安装 —— 递一条 shell 命令过来,响亮地说这儿没有这条通道', async () => {
    // #6098:本机 shell 直装那条腿删了。留一条「命令我照跑」的后门,等于把 npm / 厂商脚本
    // 那一套从后门放回来,而它们的落点谁也不知道。
    const result = await createLocalInstallCommandRunner()('npm install -g @openai/codex');

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe('unsupported-host');
    expect(mocks.runMiseOperation).not.toHaveBeenCalled();
  });
});
