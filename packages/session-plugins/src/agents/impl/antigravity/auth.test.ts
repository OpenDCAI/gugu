import { describe, expect, it, vi } from 'vitest';
import type { AgentAuthContext, PluginFs } from '@gugu/session-core/agents/plugins';
import { ANTIGRAVITY_CLI_SETTINGS_PATH, antigravityAuthStatus, antigravityCliAuthStatus } from './auth';

const SETTINGS = '.gemini/antigravity-acp/settings.json';

function ctx(options: {
  files?: Record<string, string>;
  readError?: Error;
  env?: Record<string, string>;
  keychain?: 'present' | 'absent' | 'broken';
  fsFollowsConfigRoot?: boolean;
}): AgentAuthContext & { exec: ReturnType<typeof vi.fn> } {
  const fs = {
    read: vi.fn(async (path: string) => {
      if (options.readError) throw options.readError;
      return options.files?.[path] ?? null;
    }),
  } as unknown as PluginFs;
  const exec = vi.fn(async () => {
    if (options.keychain === 'present') return { stdout: 'keychain: …', stderr: '' };
    if (options.keychain === 'absent') throw Object.assign(new Error('not found'), { code: 44 });
    throw Object.assign(new Error('security: boom'), { code: 1 });
  });
  return {
    cli: '/managed/agy_acp_server',
    exec,
    fs,
    env: options.env ?? {},
    fsFollowsConfigRoot: options.fsFollowsConfigRoot,
  };
}

const oauthPersonal = JSON.stringify({ auth: { type: 'oauth-personal' } });

describe('antigravityAuthStatus', () => {
  it('macOS:auth.type=oauth-personal 且钥匙串有 gemini/antigravity-acp ⇒ authenticated(不带 -w,不弹框)', async () => {
    const c = ctx({ files: { [SETTINGS]: oauthPersonal }, keychain: 'present' });
    await expect(antigravityAuthStatus(c, 'darwin')).resolves.toEqual({ kind: 'authenticated' });
    expect(c.exec).toHaveBeenCalledWith(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'gemini', '-a', 'antigravity-acp'],
      expect.anything()
    );
  });

  it('钥匙串那一项不在(退出码 44)⇒ unauthenticated', async () => {
    const c = ctx({ files: { [SETTINGS]: oauthPersonal }, keychain: 'absent' });
    await expect(antigravityAuthStatus(c, 'darwin')).resolves.toMatchObject({ kind: 'unauthenticated' });
  });

  it('钥匙串读失败(非 44)⇒ unknown,❌ 不当阴性', async () => {
    const c = ctx({ files: { [SETTINGS]: oauthPersonal }, keychain: 'broken' });
    await expect(antigravityAuthStatus(c, 'darwin')).resolves.toMatchObject({ kind: 'unknown' });
  });

  it('没有 settings.json ⇒ unauthenticated;没有 auth.type ⇒ unauthenticated', async () => {
    await expect(antigravityAuthStatus(ctx({}), 'darwin')).resolves.toMatchObject({ kind: 'unauthenticated' });
    await expect(
      antigravityAuthStatus(ctx({ files: { [SETTINGS]: '{}' }, keychain: 'present' }), 'darwin')
    ).resolves.toMatchObject({ kind: 'unauthenticated' });
  });

  it('settings.json 读失败或解析失败 ⇒ unknown', async () => {
    await expect(antigravityAuthStatus(ctx({ readError: new Error('EACCES') }), 'darwin')).resolves.toMatchObject({
      kind: 'unknown',
    });
    await expect(antigravityAuthStatus(ctx({ files: { [SETTINGS]: '{' } }), 'darwin')).resolves.toMatchObject({
      kind: 'unknown',
    });
  });

  it('非 macOS 或 AGY_ACP_FORCE_FILE_STORAGE=1:看 token 文件,不碰钥匙串', async () => {
    const withToken = ctx({
      files: { [SETTINGS]: oauthPersonal, '.gemini/antigravity-acp/acp_token.json': '{}' },
    });
    await expect(antigravityAuthStatus(withToken, 'linux')).resolves.toEqual({ kind: 'authenticated' });
    expect(withToken.exec).not.toHaveBeenCalled();

    const forced = ctx({ files: { [SETTINGS]: oauthPersonal }, env: { AGY_ACP_FORCE_FILE_STORAGE: '1' } });
    await expect(antigravityAuthStatus(forced, 'darwin')).resolves.toMatchObject({ kind: 'unauthenticated' });
    expect(forced.exec).not.toHaveBeenCalled();

    const business = ctx({
      files: {
        [SETTINGS]: JSON.stringify({ auth: { type: 'oauth-business' } }),
        '.gemini/antigravity-acp/acp_business_token.json': '{}',
      },
    });
    await expect(antigravityAuthStatus(business, 'linux')).resolves.toEqual({ kind: 'authenticated' });
  });

  it('gemini-api-key:凭据就是进程环境里的 GEMINI_API_KEY', async () => {
    const settings = { [SETTINGS]: JSON.stringify({ auth: { type: 'gemini-api-key' } }) };
    await expect(
      antigravityAuthStatus(ctx({ files: settings, env: { GEMINI_API_KEY: 'k' } }), 'darwin')
    ).resolves.toEqual({ kind: 'authenticated' });
    await expect(antigravityAuthStatus(ctx({ files: settings }), 'darwin')).resolves.toMatchObject({
      kind: 'unknown',
    });
  });

  it('GEMINI_HOME 被用户挪走、fs 却锚在真 home ⇒ unknown;fs 跟着配置根时照常判', async () => {
    const moved = ctx({ files: { [SETTINGS]: oauthPersonal }, env: { GEMINI_HOME: '/elsewhere' }, keychain: 'present' });
    await expect(antigravityAuthStatus(moved, 'darwin')).resolves.toMatchObject({ kind: 'unknown' });
    const followed = ctx({
      files: { [SETTINGS]: oauthPersonal },
      env: { GEMINI_HOME: '/gugu/.gemini' },
      keychain: 'present',
      fsFollowsConfigRoot: true,
    });
    await expect(antigravityAuthStatus(followed, 'darwin')).resolves.toEqual({ kind: 'authenticated' });
  });
});

describe('antigravityCliAuthStatus(终端腿的 agy,#6335)', () => {
  const managed = { GEMINI_HOME: '/gugu/agent-homes/antigravity/.gemini' };
  const signedOutError = () => Object.assign(new Error('exit 1'), {
    code: 1, stdout: 'Fetching available models...\n',
    stderr: 'Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n',
  });
  function managedCtx(options: Parameters<typeof ctx>[0] = {}) {
    return ctx({ fsFollowsConfigRoot: true, ...options, env: { ...managed, ...options.env } });
  }

  it('问 agy 自己 —— `agy models` 退出 0 ⇒ authenticated,经同一个启动器在影子 home 里跑', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const c = managedCtx({ keychain: 'present' });
      await expect(antigravityCliAuthStatus(c, platform)).resolves.toEqual({ kind: 'authenticated' });
      const [command, args, opts] = c.exec.mock.calls[0]!;
      expect(command).toBe('/usr/bin/env');
      expect(args).toEqual([`GEMINI_HOME=${managed.GEMINI_HOME}`, '/bin/sh', '-c', expect.any(String), c.cli, 'models']);
      expect(opts).toEqual({ timeout: 15_000 });
    }
  });

  it('退出 1 且说「Please sign in」⇒ unauthenticated;超时或别的失败 ⇒ unknown(失败仪器不是阴性读数)', async () => {
    const signedOut = managedCtx();
    signedOut.exec.mockRejectedValueOnce(signedOutError());
    await expect(antigravityCliAuthStatus(signedOut, 'darwin')).resolves.toMatchObject({ kind: 'unauthenticated' });
    const timedOut = managedCtx();
    timedOut.exec.mockRejectedValueOnce(Object.assign(new Error('timed out'), { code: null, killed: true }));
    await expect(antigravityCliAuthStatus(timedOut, 'darwin')).resolves.toMatchObject({ kind: 'unknown' });
    await expect(antigravityCliAuthStatus(managedCtx(), 'linux')).resolves.toMatchObject({ kind: 'unknown' });
  });

  it('失败的原因给人看:超时说几秒没答，别的失败给 agy 自己的话 —— ❌ 把整条启动命令(含启动器脚本)当原因', async () => {
    // execFile 的报错形状:message = 「Command failed: <整条命令>\n<stderr>」,超时多一个 killed。
    const commandLine = `Command failed: /usr/bin/env GEMINI_HOME=${managed.GEMINI_HOME} /bin/sh -c case "\${GEMINI_HOME:-}" in`;
    const timedOut = managedCtx();
    timedOut.exec.mockRejectedValueOnce(
      Object.assign(new Error(`${commandLine}\nFetching available models...\n`), {
        code: null, killed: true, signal: 'SIGTERM', stdout: '', stderr: 'Fetching available models...\n',
      })
    );
    const slow = await antigravityCliAuthStatus(timedOut, 'darwin');
    expect(slow).toEqual({ kind: 'unknown', message: 'agy models 15 秒没答完(它要联网拉模型列表)。' });

    const broken = managedCtx();
    broken.exec.mockRejectedValueOnce(
      Object.assign(new Error(`${commandLine}\nFetching available models...\nError: network unreachable\n`), {
        code: 2, stdout: '', stderr: 'Fetching available models...\nError: network unreachable\n',
      })
    );
    expect(await antigravityCliAuthStatus(broken, 'darwin')).toEqual({
      kind: 'unknown',
      message: 'agy models 失败(退出码 2):Error: network unreachable',
    });
  });

  it('聊天面板那个程序登没登与它无关:ACP 的 settings 在不在都不影响这份读数', async () => {
    const c = managedCtx({ files: { [SETTINGS]: oauthPersonal } });
    c.exec.mockRejectedValueOnce(signedOutError());
    await expect(antigravityCliAuthStatus(c, 'darwin')).resolves.toMatchObject({ kind: 'unauthenticated' });
  });

  it('API key 模式(modelProvider=gemini + GEMINI_API_KEY)⇒ authenticated,不去问 agy', async () => {
    const c = managedCtx({
      files: { [ANTIGRAVITY_CLI_SETTINGS_PATH]: JSON.stringify({ modelProvider: 'gemini' }) },
      env: { GEMINI_API_KEY: 'k' },
    });
    await expect(antigravityCliAuthStatus(c, 'darwin')).resolves.toEqual({ kind: 'authenticated' });
    expect(c.exec).not.toHaveBeenCalled();
  });

  it('API key 模式但环境里没有 key ⇒ unknown(它会起不来,但咕咕的登录入口也救不了它)', async () => {
    const c = managedCtx({ files: { [ANTIGRAVITY_CLI_SETTINGS_PATH]: JSON.stringify({ modelProvider: 'gemini' }) } });
    await expect(antigravityCliAuthStatus(c, 'darwin')).resolves.toMatchObject({
      kind: 'unknown',
      message: expect.stringContaining('GEMINI_API_KEY'),
    });
  });

  it('modelProvider 是别的值 ⇒ 它当没设、照常走账号(「gemini is the only accepted value」)', async () => {
    const c = managedCtx({
      files: { [ANTIGRAVITY_CLI_SETTINGS_PATH]: JSON.stringify({ modelProvider: 'openai' }) },
      env: { GEMINI_API_KEY: 'k' },
    });
    c.exec.mockRejectedValueOnce(signedOutError());
    await expect(antigravityCliAuthStatus(c, 'darwin')).resolves.toMatchObject({ kind: 'unauthenticated' });
  });

  it('settings.json 坏了 / 读不出 ⇒ unknown', async () => {
    await expect(
      antigravityCliAuthStatus(managedCtx({ files: { [ANTIGRAVITY_CLI_SETTINGS_PATH]: '{' } }), 'darwin')
    ).resolves.toMatchObject({ kind: 'unknown' });
    await expect(
      antigravityCliAuthStatus(managedCtx({ readError: new Error('EACCES') }), 'darwin')
    ).resolves.toMatchObject({ kind: 'unknown', message: expect.stringContaining('EACCES') });
  });

  it('Windows:没有终端腿 ⇒ unknown,不去问', async () => {
    const c = managedCtx({ keychain: 'present' });
    await expect(antigravityCliAuthStatus(c, 'win32')).resolves.toMatchObject({ kind: 'unknown' });
    expect(c.exec).not.toHaveBeenCalled();
  });

  it('GEMINI_HOME 被用户挪走且 fs 锚在真 home ⇒ unknown,不去问', async () => {
    const c = ctx({ env: { GEMINI_HOME: '/elsewhere/.gemini' }, keychain: 'present' });
    await expect(antigravityCliAuthStatus(c, 'darwin')).resolves.toMatchObject({ kind: 'unknown' });
    expect(c.exec).not.toHaveBeenCalled();
  });
});
