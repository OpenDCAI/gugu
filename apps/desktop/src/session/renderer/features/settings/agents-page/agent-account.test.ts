import type { AuthStatusModelState } from '@gugu/session-core/workspace-server/agent-config';
import { describe, expect, it } from 'vitest';
import type { AgentCapabilities } from '@shared/core/agents/agent-payload';
import {
  accountRowOf,
  mergeAccountRows,
  resolveAccountRow,
  resolveAccountTargets,
  resolveSignInMethod,
  resolveSignInTarget,
} from './agent-account';
import type { AgentPayload, AgentProgramStatus } from '@shared/core/agents/agent-payload';

const caps = (auth: AgentCapabilities['auth']): AgentCapabilities => ({ auth }) as AgentCapabilities;

const CLI_LOGIN = caps({
  kind: 'supported',
  methods: [
    { kind: 'cli-login', id: 'claude-login', name: 'Sign in with Claude', args: ['auth', 'login'] },
  ],
});

/** gemini / qwen 从前的形状:声明了 auth,却只有一条产品里点不动的 api-key。 */
const API_KEY_ONLY = caps({
  kind: 'supported',
  methods: [
    {
      kind: 'api-key',
      id: 'gemini-api-key',
      name: 'Use a Gemini API key',
      envVars: [{ name: 'GEMINI_API_KEY', label: 'Gemini API key' }],
    },
  ],
});

const NO_AUTH = caps({ kind: 'none' });

const authState = (status: AuthStatusModelState['status']): AuthStatusModelState => ({
  status,
  login: null,
});

describe('resolveSignInMethod', () => {
  it('认 cli-login 与 acp-authenticate,api-key 不算(咕咕没有填 key 的界面)', () => {
    expect(resolveSignInMethod(CLI_LOGIN)?.id).toBe('claude-login');
    expect(resolveSignInMethod(API_KEY_ONLY)).toBeNull();
    expect(resolveSignInMethod(NO_AUTH)).toBeNull();
    expect(resolveSignInMethod(null)).toBeNull();
    expect(resolveSignInMethod(undefined)).toBeNull();
  });

  it('cli-login 和 api-key 混在一家时取 cli-login(claude / codex / opencode 的形状)', () => {
    const mixed = caps({
      kind: 'supported',
      methods: [
        {
          kind: 'api-key',
          id: 'provider-api-key',
          name: 'Use provider API keys',
          envVars: [{ name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key' }],
        },
        { kind: 'cli-login', id: 'opencode-login', name: 'Sign in', args: ['auth', 'login'] },
      ],
    });
    expect(resolveSignInMethod(mixed)?.id).toBe('opencode-login');
  });

  it('协议登录(acp-authenticate,#6335)同样是一种能在产品里发起的登录', () => {
    const acp = caps({
      kind: 'supported',
      methods: [
        { kind: 'acp-authenticate', id: 'google', name: 'Google 账号', methodId: 'oauth-personal' },
      ],
    });
    expect(resolveSignInMethod(acp)).toEqual({
      kind: 'acp-authenticate',
      id: 'google',
      name: 'Google 账号',
      methodId: 'oauth-personal',
    });
    expect(resolveAccountRow(acp, authState({ kind: 'unauthenticated' }), 'available')).toMatchObject({
      status: 'signed-out',
      canSignIn: true,
      method: { kind: 'acp-authenticate' },
    });
  });
});

describe('resolveAccountRow:哪些家压根不该有这一行', () => {
  /**
   * 这三条是本票的核心判据:**只对真能在产品内登录的家**画这一行。
   *
   * 阳控在下一个 describe 里 —— 同一个函数、同一份 auth 读数,换成声明了 cli-login 的家就必须
   * 给出行。没有它,这三条 `toBeNull()` 也可能只是因为函数永远返回 null。
   */
  it('只声明 api-key 的家:不渲染', () => {
    expect(resolveAccountRow(API_KEY_ONLY, authState({ kind: 'unauthenticated' }), 'available')).toBeNull();
  });

  it('压根没声明 auth 的家:不渲染', () => {
    expect(resolveAccountRow(NO_AUTH, authState({ kind: 'authenticated' }), 'available')).toBeNull();
  });

  it('capabilities 还没到:不渲染', () => {
    expect(resolveAccountRow(null, authState({ kind: 'unauthenticated' }), 'available')).toBeNull();
  });
});

describe('resolveAccountRow:四态', () => {
  it('已登录 —— harness 给了账号就带上', () => {
    const row = resolveAccountRow(
      CLI_LOGIN,
      authState({ kind: 'authenticated', account: 'me@example.com' }),
      'available'
    );
    expect(row).toEqual({
      legs: null,
      method: expect.objectContaining({ id: 'claude-login' }),
      status: 'signed-in',
      account: 'me@example.com',
      message: null,
      canSignIn: true,
    });
  });

  it('已登录但 harness 没给账号 —— account 为 null,❌ 不编一个', () => {
    const row = resolveAccountRow(CLI_LOGIN, authState({ kind: 'authenticated' }), 'available');
    expect(row?.status).toBe('signed-in');
    expect(row?.account).toBeNull();
  });

  it('未登录 —— 带上 harness 自己那句原话', () => {
    const row = resolveAccountRow(
      CLI_LOGIN,
      authState({ kind: 'unauthenticated', message: '没有找到凭据' }),
      'available'
    );
    expect(row?.status).toBe('signed-out');
    expect(row?.message).toBe('没有找到凭据');
  });

  it('未知 —— 判不出,原因照转', () => {
    const row = resolveAccountRow(
      CLI_LOGIN,
      authState({ kind: 'unknown', message: '配置根被挪走了' }),
      'available'
    );
    expect(row?.status).toBe('unknown');
    expect(row?.message).toBe('配置根被挪走了');
  });

  it('还没读到 ≠ 判不出:在途是 checking', () => {
    expect(resolveAccountRow(CLI_LOGIN, null, 'available')?.status).toBe('checking');
    expect(resolveAccountRow(CLI_LOGIN, undefined, 'available')?.status).toBe('checking');
    // 反向:真读到一个 unknown 才是 unknown。两者共用一个值就没法区分「没问过」和「问了答不上」。
    expect(resolveAccountRow(CLI_LOGIN, authState({ kind: 'unknown' }), 'available')?.status).toBe(
      'unknown'
    );
  });

  it('没装的家:行还在(它就是那句「这家要登录」的表达),但登录不给点', () => {
    for (const status of ['missing', 'error', undefined] as const) {
      const row = resolveAccountRow(CLI_LOGIN, authState({ kind: 'unknown' }), status);
      expect(row?.canSignIn).toBe(false);
    }
    expect(resolveAccountRow(CLI_LOGIN, authState({ kind: 'unknown' }), 'available')?.canSignIn).toBe(
      true
    );
  });
});

describe('#6264 登录已失效', () => {
  it('凭据还在、真用时被拒:单独一态「expired」,❌ 与没登录过说成一回事', () => {
    const row = resolveAccountRow(CLI_LOGIN, authState({ kind: 'unauthenticated', reason: 'expired' }), 'available');
    expect(row?.status).toBe('expired');
    expect(resolveAccountRow(CLI_LOGIN, authState({ kind: 'unauthenticated' }), 'available')?.status).toBe('signed-out');
  });
});

describe('按程序登录(#6335:一家两条腿是两个不共享登录的程序)', () => {
  const AGY = caps({
    kind: 'supported',
    methods: [{ kind: 'acp-authenticate', id: 'google', name: 'Google 账号', methodId: 'oauth-personal' }],
    programs: {
      'antigravity-cli': {
        methods: [{ kind: 'cli-login', id: 'google', name: 'Google 账号', args: [] }],
      },
    },
  });
  const program = (
    dependencyId: string,
    legs: AgentProgramStatus['legs'],
    status: AgentProgramStatus['status']
  ): AgentProgramStatus => ({
    dependencyId,
    name: dependencyId,
    binaryName: dependencyId,
    legs,
    reading: status === 'available' ? 'installed' : 'not-detected',
    status,
    version: null,
    managed: true,
    managedVersion: null,
    managedUpdateAvailable: false,
  });
  const agent = (
    capabilities: AgentCapabilities,
    programs?: AgentProgramStatus[]
  ): Pick<AgentPayload, 'capabilities' | 'programs' | 'status'> => ({
    capabilities,
    ...(programs ? { programs } : {}),
    status: 'available',
  });
  const antigravity = agent(AGY, [
    program('antigravity', ['acp'], 'available'),
    program('antigravity-cli', ['tui'], 'missing'),
  ]);

  it('resolveSignInMethod 按程序取方法:缺席 = 主程序,给了 = 它自己声明的那份,没声明 = null', () => {
    expect(resolveSignInMethod(AGY)?.kind).toBe('acp-authenticate');
    expect(resolveSignInMethod(AGY, 'antigravity-cli')?.kind).toBe('cli-login');
    expect(resolveSignInMethod(AGY, 'unknown-program')).toBeNull();
  });

  it('resolveSignInTarget 按腿:编程模式那条腿登 agy,通用模式那条腿登主程序;单程序的家两条腿都是主程序', () => {
    expect(resolveSignInTarget(antigravity, 'tui')).toEqual({
      program: 'antigravity-cli',
      method: expect.objectContaining({ kind: 'cli-login' }),
    });
    expect(resolveSignInTarget(antigravity, 'acp')).toEqual({
      program: undefined,
      method: expect.objectContaining({ kind: 'acp-authenticate' }),
    });
    const single = agent(CLI_LOGIN);
    expect(resolveSignInTarget(single, 'tui')?.program).toBeUndefined();
    expect(resolveSignInTarget(single, 'acp')?.method.id).toBe('claude-login');
    // 伴随程序没声明自己的登录 ⇒ 那条腿没有能在咕咕里发起的登录,❌ 回落主程序
    const undeclared = agent(CLI_LOGIN, [
      program('x', ['acp'], 'available'),
      program('x-cli', ['tui'], 'available'),
    ]);
    expect(resolveSignInTarget(undeclared, 'tui')).toBeNull();
    expect(resolveSignInTarget(null, 'acp')).toBeNull();
  });

  it('resolveAccountTargets:几个程序各一行、各带腿与自己的安装读数;单程序的家一行、不带腿', () => {
    expect(resolveAccountTargets(antigravity)).toEqual([
      { program: undefined, method: expect.objectContaining({ kind: 'acp-authenticate' }), legs: ['acp'], installStatus: 'available' },
      { program: 'antigravity-cli', method: expect.objectContaining({ kind: 'cli-login' }), legs: ['tui'], installStatus: 'missing' },
    ]);
    expect(resolveAccountTargets(agent(CLI_LOGIN))).toEqual([
      { program: undefined, method: expect.objectContaining({ id: 'claude-login' }), legs: null, installStatus: 'available' },
    ]);
    expect(resolveAccountTargets(agent(API_KEY_ONLY))).toEqual([]);
  });

  it('accountRowOf:每行只看自己那个程序 —— agy 没装时终端那一行不给点,聊天面板那一行照常', () => {
    const [chat, terminal] = resolveAccountTargets(antigravity);
    const chatRow = accountRowOf(chat!, authState({ kind: 'authenticated' }));
    const terminalRow = accountRowOf(terminal!, authState({ kind: 'unauthenticated', message: '钥匙串里没有 agy 的登录凭据。' }));
    expect(chatRow).toMatchObject({ status: 'signed-in', canSignIn: true, legs: ['acp'] });
    expect(chatRow).not.toHaveProperty('program');
    expect(terminalRow).toMatchObject({
      program: 'antigravity-cli',
      status: 'signed-out',
      canSignIn: false,
      message: '钥匙串里没有 agy 的登录凭据。',
    });
    expect(accountRowOf(terminal!, null).status).toBe('checking');
  });
});

describe('mergeAccountRows(资源库一行、一颗按钮,#6335 owner 定)', () => {
  const ACP = { kind: 'acp-authenticate', id: 'google', name: 'G', methodId: 'oauth-personal' } as const;
  const CLI = { kind: 'cli-login', id: 'google', name: 'G', args: [] as string[] } as const;
  const chat = (status: AuthStatusModelState['status'] | null, installStatus: 'available' | 'missing' = 'available') =>
    accountRowOf({ program: undefined, method: ACP, legs: ['acp'], installStatus }, status ? authState(status) : null);
  const term = (status: AuthStatusModelState['status'] | null, installStatus: 'available' | 'missing' = 'available') =>
    accountRowOf({ program: 'antigravity-cli', method: CLI, legs: ['tui'], installStatus }, status ? authState(status) : null);
  const IN = { kind: 'authenticated' } as const;
  const OUT = { kind: 'unauthenticated', message: '钥匙串里没有 agy 的登录凭据。' } as const;
  const UNK = { kind: 'unknown', message: '这个系统上…' } as const;

  it('全登了 ⇒ 已登录,按钮重登全部', () => {
    const merged = mergeAccountRows([chat(IN), term(IN)])!;
    expect(merged.status).toBe('signed-in');
    expect(merged.steps.map((row) => row.program)).toEqual([undefined, 'antigravity-cli']);
  });

  it('有的登了有的没登 ⇒ 还差一步,只跑没登的;说明按模式、❌ 不带程序自己的原话', () => {
    const merged = mergeAccountRows([chat(IN), term(OUT)])!;
    expect(merged).toMatchObject({ status: 'partial', pendingLegs: ['tui'], message: null, canSignIn: true });
    expect(merged.steps.map((row) => row.program)).toEqual(['antigravity-cli']);
  });

  it('都没登 ⇒ 未登录,两个都跑、按声明顺序', () => {
    const merged = mergeAccountRows([chat(OUT), term(OUT)])!;
    expect(merged.status).toBe('signed-out');
    expect(merged.steps.map((row) => row.program)).toEqual([undefined, 'antigravity-cli']);
  });

  it('判不出:没有明确没登的 ⇒ 未知(❌ 当成登了),要跑的包括判不出的那个;有明确没登的 ⇒ 以它为准', () => {
    const unknown = mergeAccountRows([chat(IN), term(UNK)])!;
    expect(unknown.status).toBe('unknown');
    expect(unknown.steps.map((row) => row.program)).toEqual(['antigravity-cli']);
    expect(mergeAccountRows([chat(OUT), term(UNK)])!.status).toBe('signed-out');
    expect(mergeAccountRows([chat(IN), term(OUT)])!.status).toBe('partial');
  });

  it('任何一个还没读到 ⇒ 正在检查', () => {
    expect(mergeAccountRows([chat(IN), term(null)])!.status).toBe('checking');
  });

  it('要跑的那一步没装 ⇒ 不给点,并指出是哪一步;已登上且不用跑的那个没装不挡', () => {
    const blocked = mergeAccountRows([chat(IN), term(OUT, 'missing')])!;
    expect(blocked.canSignIn).toBe(false);
    expect(blocked.blockedBy?.method.kind).toBe('cli-login');
    expect(mergeAccountRows([chat(IN, 'missing'), term(OUT)])!.canSignIn).toBe(true);
  });

  it('单程序的家:与 resolveAccountRow 同一个读数,steps 就是它自己;没有可登的 ⇒ null', () => {
    const row = resolveAccountRow(CLI_LOGIN, authState({ kind: 'unauthenticated', message: '没有找到凭据' }), 'available')!;
    const merged = mergeAccountRows([row])!;
    expect(merged).toMatchObject({ status: 'signed-out', message: '没有找到凭据', canSignIn: true, pendingLegs: [] });
    expect(merged.steps).toEqual([row]);
    expect(mergeAccountRows([])).toBeNull();
  });
});
