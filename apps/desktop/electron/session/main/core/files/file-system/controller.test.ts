import { describe, expect, it, vi } from 'vitest';
import { ok } from '@gugu/session-shared';

// 工作区:根 /root(d22 上「~」那一行的会话),realPath 原样返回(这里只钉路径围栏,不钉符号链接)。
const workspace = vi.hoisted(() => ({
  path: '/root',
  fileSystem: { realPath: async (p: string) => ({ success: true as const, data: p }) },
}));

vi.mock('electron', () => ({ protocol: { isProtocolHandled: () => false, handle: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { on: () => () => undefined, emit: vi.fn() } }));
vi.mock('../../projects/utils', () => ({
  resolveWorkspace: (_projectId: string, workspaceId: string) => (workspaceId === 'ws' ? workspace : null),
}));

import { workspaceFileSystemController } from './controller';

const { getAbsolutePath } = workspaceFileSystemController;

describe('workspace.files.getAbsolutePath', () => {
  // #6264 实机:别的机器上的会话点「查看预览」先问这条会话的工作目录(`.`),从前被「Path must not be empty」拒掉,
  // 预览恒显示「没能打开 d22 上的这个网页。」
  it.each(['.', ''])('%j 是工作区根本身', async (input) => {
    expect(await getAbsolutePath('p', 'ws', input)).toEqual(ok({ path: '/root' }));
  });

  it('工作区里的相对路径与绝对路径照旧', async () => {
    expect(await getAbsolutePath('p', 'ws', 'tab-demo/index.html')).toEqual(ok({ path: '/root/tab-demo/index.html' }));
    expect(await getAbsolutePath('p', 'ws', '/root/tab-demo/index.html')).toEqual(ok({ path: '/root/tab-demo/index.html' }));
  });

  it('工作区外仍然拒绝', async () => {
    for (const input of ['../etc/passwd', '/etc/passwd']) {
      const result = await getAbsolutePath('p', 'ws', input);
      expect(result.success).toBe(false);
    }
  });

  it('工作区不在 = not_found', async () => {
    const result = await getAbsolutePath('p', 'gone', '.');
    expect(result.success).toBe(false);
  });
});
