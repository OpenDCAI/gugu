import { describe, expect, it } from 'vitest';
import type { AgentAuthContext, PluginFs } from '@gugu/session-core/agents/plugins';
import { codebuddyAuthDir, codebuddyAuthStatus } from './auth';

function ctx(options: { files?: Record<string, string>; env?: Record<string, string>; readError?: Error }): AgentAuthContext {
  const files = options.files ?? {};
  const fs = {
    read: async (path: string) => {
      if (options.readError) throw options.readError;
      return files[path] ?? null;
    },
    exists: async (path: string) => path in files,
    list: async (dir: string) =>
      Object.keys(files)
        .filter((path) => path.startsWith(`${dir}/`))
        .map((path) => path.slice(dir.length + 1)),
  } as unknown as PluginFs;
  return {
    cli: 'codebuddy',
    exec: async () => ({ stdout: '', stderr: '' }),
    fs,
    env: options.env ?? {},
  };
}

// 2.179.3 落盘的形状:令牌字段可能是密文,键还在。
const SESSION = JSON.stringify({
  auth: { accessToken: 'enc:…', refreshToken: 'enc:…', domain: 'www.codebuddy.ai' },
  account: { uid: 'u1', nickname: 'enc:…' },
});

describe('codebuddyAuthDir', () => {
  it('按平台落在 home 下的 CodeBuddyExtension 数据根(win32 是 AppData/Local,不是 .codebuddy)', () => {
    expect(codebuddyAuthDir('win32')).toBe('AppData/Local/CodeBuddyExtension/Data/Public/auth');
    expect(codebuddyAuthDir('darwin')).toBe('Library/Application Support/CodeBuddyExtension/Data/Public/auth');
    expect(codebuddyAuthDir('linux')).toBe('.local/share/CodeBuddyExtension/Data/Public/auth');
  });
});

describe.each(['win32', 'darwin', 'linux'] as const)('codebuddyAuthStatus(%s)', (platform) => {
  const file = `${codebuddyAuthDir(platform)}/Tencent-Cloud.coding-copilot.info`;

  it('浏览器登录落盘的会话在 ⇒ authenticated', async () => {
    await expect(codebuddyAuthStatus(ctx({ files: { [file]: SESSION } }), platform)).resolves.toEqual({
      kind: 'authenticated',
    });
  });

  it('有登出标记 ⇒ unauthenticated(它登出不删文件)', async () => {
    const status = await codebuddyAuthStatus(
      ctx({ files: { [file]: SESSION, [`${file}.logged-out`]: '' } }),
      platform
    );
    expect(status.kind).toBe('unauthenticated');
  });

  it('没有会话文件 ⇒ unauthenticated;只有它自己登出留下的备份也一样', async () => {
    expect((await codebuddyAuthStatus(ctx({}), platform)).kind).toBe('unauthenticated');
    const backup = `${codebuddyAuthDir(platform)}/Tencent-Cloud.coding-copilot.2026-11-04T00-00-00-000Z.1.x.info`;
    expect((await codebuddyAuthStatus(ctx({ files: { [backup]: SESSION } }), platform)).kind).toBe('unauthenticated');
  });

  it('会话里缺 auth 或 account ⇒ unauthenticated', async () => {
    const status = await codebuddyAuthStatus(ctx({ files: { [file]: JSON.stringify({ auth: {} }) } }), platform);
    expect(status.kind).toBe('unauthenticated');
  });

  it('读不出 / 解析不出 / 只有定制产品的会话 ⇒ unknown,❌ 当成没登录', async () => {
    expect((await codebuddyAuthStatus(ctx({ readError: new Error('EACCES') }), platform)).kind).toBe('unknown');
    expect((await codebuddyAuthStatus(ctx({ files: { [file]: '{' } }), platform)).kind).toBe('unknown');
    const custom = `${codebuddyAuthDir(platform)}/Tencent-Cloud.coding-copilot-custom-acme.info`;
    expect((await codebuddyAuthStatus(ctx({ files: { [custom]: SESSION } }), platform)).kind).toBe('unknown');
  });

  it('环境里有 CODEBUDDY_API_KEY ⇒ authenticated(api-key),不看文件', async () => {
    await expect(
      codebuddyAuthStatus(ctx({ env: { CODEBUDDY_API_KEY: 'k' } }), platform)
    ).resolves.toEqual({ kind: 'authenticated', credentialKind: 'api-key' });
  });
});
