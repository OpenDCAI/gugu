import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import { codexCredentialInfo, codexCredentialKind } from './auth';

/**
 * fs 锚在用户真 home(Codex 是 `injectionMode:'runtime'`,不声明 configRoot)。只有
 * `.codex/auth.json` 这一个路径有内容 —— #7146:旧实现读的是 home 下的 `auth.json`,
 * 而旧夹具对任何路径都返回同一份内容,读错文件也照样绿。
 */
function ctx(raw: string | null, env: Record<string, string> = {}): AgentAuthContext {
  return {
    cli: 'codex',
    env,
    exec: vi.fn(),
    fs: {
      // 与 `createLocalPluginFs` 同一个约定:文件不存在 ⇒ null。
      read: vi.fn(async (path: string) => (path === '.codex/auth.json' ? raw : null)),
      write: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
    },
  };
}

describe('codexCredentialKind', () => {
  it('reads the official auth.json apikey mode', async () => {
    await expect(codexCredentialKind(ctx('{"auth_mode":"apikey"}'))).resolves.toBe('api-key');
  });

  it('reads the official auth.json chatgpt mode as a subscription route', async () => {
    await expect(codexCredentialKind(ctx('{"auth_mode":"chatgpt"}'))).resolves.toBe('subscription');
  });

  it('fails closed when auth root was moved or the mode is unknown', async () => {
    await expect(
      codexCredentialKind(ctx('{"auth_mode":"apikey"}', { CODEX_HOME: '/custom' }))
    ).resolves.toBe('unknown');
    await expect(codexCredentialKind(ctx('{"auth_mode":"future"}'))).resolves.toBe('unknown');
  });
});

 it('reads only the selected auth file’s display email and never returns tokens', async () => {
  const token = 'header.' + Buffer.from(JSON.stringify({ email: 'work@example.test' })).toString('base64url') + '.signature';
  const context = { ...ctx(JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: token, access_token: 'secret' } }), { CODEX_HOME: '/owned/work/.codex' }), fsFollowsConfigRoot: true };
  await expect(codexCredentialInfo(context)).resolves.toEqual({ kind: 'subscription', account: 'work@example.test' });
});
