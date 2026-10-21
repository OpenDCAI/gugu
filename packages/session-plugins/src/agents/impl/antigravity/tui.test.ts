import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionCapabilityBundle } from '@gugu/session-core/agents/plugins';
import { createLocalPluginFs, isGuguHookText } from '@gugu/session-core/agents/plugins/helpers';
import { pluginRegistry, resolveSessionTuiDeliveryToolNames } from '../../registry';
import {
  ANTIGRAVITY_GUGU_HOOK_GROUP,
  ANTIGRAVITY_HOOKS_PATH,
  buildAntigravityHookConfig,
  execSafeHookCommand,
} from './hooks';
import {
  ANTIGRAVITY_LAUNCH_SCRIPT,
  ANTIGRAVITY_SESSION_TUI_ENABLED,
  ANTIGRAVITY_INVOCATION_CONTEXT_ENV,
  GUGU_MCP_STDIO_RELAY_ENTRY_ENV,
  antigravitySessionBundleDescriptor,
  materializeAntigravitySessionBundle,
  trustedWorkspacePaths,
} from './session-bundle';
import { loadStopCommands } from './stop-hooks';

const tui = { surface: 'tui' as const, lifecycle: 'fresh' as const, cwd: '/work' };
const MANAGED = '/gugu/agent-homes/antigravity/.gemini';

function bundle(overrides: Partial<SessionCapabilityBundle> = {}): SessionCapabilityBundle {
  return {
    mcpServers: [
      { name: 'gugu', transport: 'http', url: 'http://127.0.0.1:1/mcp', authorizationEnv: 'GUGU_MCP_TOKEN', owner: 'gugu' },
    ],
    env: { GUGU_HOME: '/gugu', GUGU_MCP_TOKEN: 'Bearer tok-1' },
    model: null,
    autonomy: null,
    promptBlocks: { platform: 'P ', identity: 'I' },
    packages: [],
    ...overrides,
  };
}

const agy = () => pluginRegistry.get('antigravity')!;

const RELAY = '/app/dist-electron/runtime/gugu-mcp-stdio-relay.mjs';

describe.skipIf(!ANTIGRAVITY_SESSION_TUI_ENABLED)('antigravity 终端腿(agy,#6335 第二层)', () => {
  let previousRelay: string | undefined;
  beforeEach(() => {
    previousRelay = process.env[GUGU_MCP_STDIO_RELAY_ENTRY_ENV];
    process.env[GUGU_MCP_STDIO_RELAY_ENTRY_ENV] = RELAY;
  });
  afterEach(() => {
    if (previousRelay === undefined) delete process.env[GUGU_MCP_STDIO_RELAY_ENTRY_ENV];
    else process.env[GUGU_MCP_STDIO_RELAY_ENTRY_ENV] = previousRelay;
  });

  it('物化只落盘:共用 mcp_config.json 里只有与会话无关的中继条目,地址与令牌只进 spawn 环境', () => {
    const result = materializeAntigravitySessionBundle(tui, bundle());
    expect(result.argsAppend).toEqual([]);
    expect(result.acp).toBeUndefined();
    // 令牌以原名离开环境,只以中继认得的那个名字出现一次(去掉 Bearer 前缀)
    expect(result.env).not.toHaveProperty('GUGU_MCP_TOKEN');
    expect(result.env).toMatchObject({
      GUGU_SESSION_MCP_URL_GUGU: 'http://127.0.0.1:1/mcp',
      GUGU_SESSION_MCP_BEARER_GUGU: 'tok-1',
    });
    expect(result.jsonOverlays).toEqual([
      {
        sourcePath: `${MANAGED}/config/mcp_config.json`,
        path: `${MANAGED}/config/mcp_config.json`,
        patch: {
          mcpServers: {
            gugu: { command: process.execPath, args: [RELAY, 'gugu'], env: { ELECTRON_RUN_AS_NODE: '1' }, disabled: false },
          },
        },
        // 补丁只落在咕咕那几个名字下,用户从自己那份带过来的 server 由深合并原样保留
        conflict: 'gugu-owns',
        mode: 0o600,
      },
      {
        sourcePath: `${MANAGED}/antigravity-cli/cache/onboarding.json`,
        path: `${MANAGED}/antigravity-cli/cache/onboarding.json`,
        patch: { consumerOnboardingComplete: true, onboardingComplete: true },
        conflict: 'gugu-owns',
        mode: 0o600,
      },
    ]);
    // 共用文件里一个会话事实都没有:两条并发会话物化出同一份补丁
    const other = materializeAntigravitySessionBundle(
      tui,
      bundle({
        mcpServers: [
          { name: 'gugu', transport: 'http', url: 'http://127.0.0.1:2/mcp', authorizationEnv: 'GUGU_MCP_TOKEN', owner: 'gugu' },
        ],
        env: { GUGU_HOME: '/gugu', GUGU_MCP_TOKEN: 'Bearer tok-2' },
      })
    );
    expect(other.jsonOverlays?.[0]).toEqual(result.jsonOverlays?.[0]);
    expect(other.env).toMatchObject({ GUGU_SESSION_MCP_BEARER_GUGU: 'tok-2' });
    expect(JSON.stringify(result.jsonOverlays)).not.toMatch(/tok-1|127\.0\.0\.1:1/);
    expect(result.artifacts.slice(0, 2).map((artifact) => artifact.path)).toEqual([
      '/gugu/agent-homes/antigravity/.zshenv',
      '/gugu/agent-homes/antigravity/.gugu-restore-home.sh',
    ]);
    expect(result.report.units.mcp).toEqual({ status: 'loaded' });
    expect(result.prompt).toBeUndefined();
  });

  it('会话提示块:每次 spawn 一份 run-scoped 的 PreInvocation 钩子输出档(官方 injectSteps 契约),env 指过去', () => {
    const first = materializeAntigravitySessionBundle(tui, bundle());
    const context = first.artifacts.find((artifact) => artifact.path.endsWith('/pre-invocation.json'))!;
    expect(context.path.startsWith('/gugu/runtime-sessions/antigravity-invocation-context/')).toBe(true);
    expect(context.mode).toBe(0o600);
    expect(JSON.parse(context.content)).toEqual({ injectSteps: [{ ephemeralMessage: 'P I' }] });
    expect(first.env[ANTIGRAVITY_INVOCATION_CONTEXT_ENV]).toBe(context.path);
    expect(first.report.units.promptBlocks).toEqual({ status: 'loaded' });
    // 不在共用的托管配置根里、两次 spawn 两份(并发会话与前后两代进程互不可见)
    expect(context.path.includes('/agent-homes/')).toBe(false);
    const second = materializeAntigravitySessionBundle({ ...tui, lifecycle: 'resume', isResuming: true }, bundle());
    expect(second.env[ANTIGRAVITY_INVOCATION_CONTEXT_ENV]).not.toBe(context.path);
    // 没有提示块 ⇒ 一个字都不发,钩子那边 env 缺席就什么都不打
    const none = materializeAntigravitySessionBundle(tui, bundle({ promptBlocks: {} }));
    expect(none.env).not.toHaveProperty(ANTIGRAVITY_INVOCATION_CONTEXT_ENV);
    expect(none.report.units.promptBlocks.status).toBe('degraded');
  });

  it('中继没登记、或会话里出现 stdio server ⇒ 响亮失败,❌ 把会话事实写进共用文件', () => {
    delete process.env[GUGU_MCP_STDIO_RELAY_ENTRY_ENV];
    expect(() => materializeAntigravitySessionBundle(tui, bundle())).toThrow(/stdio relay/);
    process.env[GUGU_MCP_STDIO_RELAY_ENTRY_ENV] = RELAY;
    expect(() =>
      materializeAntigravitySessionBundle(
        tui,
        bundle({ mcpServers: [{ name: 'mine', transport: 'stdio', command: 'x', args: [], env: {}, owner: 'user' } as never] })
      )
    ).toThrow(/is stdio/);
  });

  it('没有 MCP server 时不写 mcp_config(一台都没送到 ≠ loaded)', () => {
    const result = materializeAntigravitySessionBundle(tui, bundle({ mcpServers: [] }));
    expect(result.jsonOverlays?.map((overlay) => overlay.path)).toEqual([
      `${MANAGED}/antigravity-cli/cache/onboarding.json`,
    ]);
    expect(result.report.units.mcp.status).toBe('degraded');
  });

  it('拿不到 GUGU_HOME 就响亮失败,❌ 猜一个落点', () => {
    expect(() => materializeAntigravitySessionBundle(tui, bundle({ env: { GUGU_MCP_TOKEN: 'x' } }))).toThrow(
      /requires bundle.env.GUGU_HOME/
    );
  });

  it('argv:启动器包在 agy 外面;首句 -i;三档权限;续跑 --conversation <原生 id>;--model 只带用户选的', () => {
    const build = agy().behavior.prompt!.buildCommand;
    const fresh = build({ cli: '/bin/agy', initialPrompt: 'hi', cliSessionId: 's', model: '' });
    expect(fresh.command).toBe('/bin/sh');
    // 没有档位的旧布尔 false ⇒ 编辑档,照样显式推旗标(#7366)
    expect(fresh.args).toEqual(['-c', ANTIGRAVITY_LAUNCH_SCRIPT, '/bin/agy', '--mode', 'accept-edits', '-i', 'hi']);

    const full = build({ cli: '/bin/agy', permissionMode: 'full-access', cliSessionId: 's', model: '' });
    expect(full.args.slice(2)).toEqual(['/bin/agy', '--dangerously-skip-permissions']);
    expect(full.autoApproved).toBe(true);
    const edit = build({ cli: '/bin/agy', permissionMode: 'edit', cliSessionId: 's', model: '' });
    expect(edit.args.slice(2)).toEqual(['/bin/agy', '--mode', 'accept-edits']);
    // 终端腿没有只读(agy 1.4.0 `--mode default` 只打 warning 照常起):绕过界面递进来就抛,❌ 落到用户自己存的档
    expect(() => build({ cli: '/bin/agy', permissionMode: 'read-only', cliSessionId: 's', model: '' }))
      .toThrow(/no read-only mode on the terminal leg/);

    const resumed = build({
      cli: '/bin/agy', cliSessionId: 's', providerSessionId: 'conv-1', isResuming: true,
      initialPrompt: 'ignored', model: 'gemini-3.1-pro-low',
    });
    expect(resumed.args.slice(2)).toEqual(['/bin/agy', '--conversation', 'conv-1', '--mode', 'accept-edits', '--model', 'gemini-3.1-pro-low']);
    // 没有原生 id 的续跑:❌ 发一个没有值的 --conversation
    expect(() => build({ cli: '/bin/agy', cliSessionId: 's', isResuming: true, model: '' })).toThrow(
      /native conversation id/
    );
  });

  it('启动器只换 agy 这一个进程的 HOME(由 GEMINI_HOME 推出影子 home),并把真 HOME 带给 shell 还原脚本', () => {
    const out = execFileSync('/bin/sh', ['-c', ANTIGRAVITY_LAUNCH_SCRIPT, '/usr/bin/env'], {
      env: { PATH: '/usr/bin:/bin', HOME: '/real/home', GEMINI_HOME: `${MANAGED}` },
      encoding: 'utf8',
    });
    const env = Object.fromEntries(out.trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2)));
    expect(env.HOME).toBe('/gugu/agent-homes/antigravity');
    expect(env.ZDOTDIR).toBe('/gugu/agent-homes/antigravity');
    expect(env.BASH_ENV).toBe('/gugu/agent-homes/antigravity/.gugu-restore-home.sh');
    expect(env.GUGU_AGY_REAL_HOME).toBe('/real/home');
    // 用户本来没设 ZDOTDIR / BASH_ENV ⇒ 不造一个「原值」出来(还原时 unset)
    expect(env).not.toHaveProperty('GUGU_AGY_REAL_ZDOTDIR');
    // 变异:GEMINI_HOME 不是托管那份 ⇒ 拒绝起,❌ 回落用户真 HOME
    expect(() =>
      execFileSync('/bin/sh', ['-c', ANTIGRAVITY_LAUNCH_SCRIPT, '/usr/bin/env'], {
        env: { PATH: '/usr/bin:/bin', HOME: '/real/home' },
        stdio: 'pipe',
      })
    ).toThrow();
  });

  it('启动器在影子 home 里放 Library/Keychains → 真 home 的软链(security 找钥匙串跟着 HOME 走),幂等且不动实体目录', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-keychain-'));
    const realHome = join(root, 'real');
    const shadow = join(root, 'shadow');
    mkdirSync(join(realHome, 'Library', 'Keychains'), { recursive: true });
    mkdirSync(join(shadow, '.gemini'), { recursive: true });
    const run = () =>
      execFileSync('/bin/sh', ['-c', ANTIGRAVITY_LAUNCH_SCRIPT, '/bin/sh', '-c', 'echo "$HOME"'], {
        env: { PATH: '/usr/bin:/bin', HOME: realHome, GEMINI_HOME: join(shadow, '.gemini') },
        encoding: 'utf8',
      }).trim();
    expect(run()).toBe(shadow);
    const link = join(shadow, 'Library', 'Keychains');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(realHome, 'Library', 'Keychains'));
    // 再起一次:照旧是那条软链(ln -sfn 覆盖,不报错、不嵌套)
    expect(run()).toBe(shadow);
    expect(readlinkSync(link)).toBe(join(realHome, 'Library', 'Keychains'));

    // 真 home 下没有 Library/Keychains(非 macOS)⇒ 什么都不做
    const otherShadow = join(root, 'shadow2');
    mkdirSync(join(otherShadow, '.gemini'), { recursive: true });
    execFileSync('/bin/sh', ['-c', ANTIGRAVITY_LAUNCH_SCRIPT, '/usr/bin/true'], {
      env: { PATH: '/usr/bin:/bin', HOME: join(root, 'no-library'), GEMINI_HOME: join(otherShadow, '.gemini') },
    });
    expect(() => lstatSync(join(otherShadow, 'Library'))).toThrow();

    // 影子 home 里已经是个实体目录 ⇒ 不替别人删目录
    const thirdShadow = join(root, 'shadow3');
    mkdirSync(join(thirdShadow, '.gemini'), { recursive: true });
    mkdirSync(join(thirdShadow, 'Library', 'Keychains'), { recursive: true });
    execFileSync('/bin/sh', ['-c', ANTIGRAVITY_LAUNCH_SCRIPT, '/usr/bin/true'], {
      env: { PATH: '/usr/bin:/bin', HOME: realHome, GEMINI_HOME: join(thirdShadow, '.gemini') },
    });
    expect(lstatSync(join(thirdShadow, 'Library', 'Keychains')).isSymbolicLink()).toBe(false);
  });

  it('agy 自己的登录(#6335):按程序声明 cli-login、有判据,登录命令走同一个启动器起裸的 agy', () => {
    const auth = agy().capabilities.auth;
    if (auth.kind !== 'supported') throw new Error('auth expected');
    // 聊天面板那个程序仍是协议登录
    expect(auth.methods.map((method) => method.kind)).toEqual(['acp-authenticate']);
    const programs = auth.programs ?? {};
    expect(Object.keys(programs)).toEqual(ANTIGRAVITY_SESSION_TUI_ENABLED ? ['antigravity-cli'] : []);
    if (!ANTIGRAVITY_SESSION_TUI_ENABLED) return;
    // 键必须是一个真实的伴随程序
    expect(agy().capabilities.hostDependency.companions?.map((companion) => companion.id)).toContain('antigravity-cli');
    expect(programs['antigravity-cli']!.methods).toEqual([
      expect.objectContaining({ kind: 'cli-login', id: 'google', args: [] }),
    ]);
    const behavior = agy().behavior.auth?.programs?.['antigravity-cli'];
    expect(behavior?.checkStatus).toBeTypeOf('function');
    expect(behavior?.buildLoginCommand?.({ cli: '/managed/bin/agy' }, 'google')).toEqual({
      command: '/bin/sh',
      args: ['-c', ANTIGRAVITY_LAUNCH_SCRIPT, '/managed/bin/agy'],
    });
  });

  it('bash 还原脚本:在假 HOME 下起的 bash 拿回真 HOME,并接着读用户原来的 BASH_ENV', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-restore-'));
    const result = materializeAntigravitySessionBundle(tui, bundle({ env: { GUGU_HOME: dir, GUGU_MCP_TOKEN: 'x' } }));
    const script = result.artifacts.find((artifact) => artifact.path.endsWith('.gugu-restore-home.sh'))!;
    const scriptPath = join(dir, 'restore.sh');
    const userEnv = join(dir, 'user-env.sh');
    writeFileSync(scriptPath, script.content);
    writeFileSync(userEnv, 'export USER_BASH_ENV_RAN=1\n');
    const out = execFileSync('bash', ['-c', 'echo "$HOME|${USER_BASH_ENV_RAN:-}|${BASH_ENV:-}"'], {
      env: {
        PATH: '/usr/bin:/bin',
        // macOS 自带 bash 3.2 在 stdin 是管道且 SHLVL 缺席时不读 BASH_ENV(本机 node spawnSync 实测:
        // stdin=pipe 不读、stdin=ignore 或带 SHLVL 就读)。真会话里 agy 是经用户的 shell 起的,SHLVL 恒在。
        SHLVL: '1',
        HOME: dir,
        BASH_ENV: scriptPath,
        GUGU_AGY_REAL_HOME: '/real/home',
        GUGU_AGY_REAL_BASH_ENV: userEnv,
      },
      encoding: 'utf8',
    });
    expect(out.trim()).toBe(`/real/home|1|${userEnv}`);
  });

  it('信任名单:启动 cwd 原样 + realpath(两者不同才写两条)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-trust-'));
    const real = realpathSync(dir);
    expect(trustedWorkspacePaths(dir)).toEqual(real === dir ? [dir] : [dir, real]);
    expect(trustedWorkspacePaths('/definitely/not/here')).toEqual(['/definitely/not/here']);
    const state = antigravitySessionBundleDescriptor.configRoot.firstRunState![0]!;
    expect(state.relPath).toBe('antigravity-cli/settings.json');
    expect(state.entries({ cwd: '/definitely/not/here' })).toEqual({
      trustedWorkspaces: ['/definitely/not/here'],
    });
  });

  it('工具名按腿:终端腿经 call_mcp_tool {ServerName, ToolName} 调、投递名是裸名;聊天面板腿如实未量', () => {
    expect(resolveSessionTuiDeliveryToolNames('antigravity')).toEqual({
      message: 'message_send',
    });
    const mcp = agy().capabilities.mcp;
    if (mcp.kind !== 'supported' || mcp.toolNames.kind !== 'per-surface') throw new Error('per-surface expected');
    expect(mcp.toolNames.surfaces['acp']).toBeUndefined();
  });

  it('分叉两条腿都有:终端腿经 sessions.forkSessionInStorage 在 antigravity-cli 存档上分叉,聊天面板腿经 acp 那一格', () => {
    expect(agy().capabilities.sessions.fork).toBe('supported');
    expect(agy().behavior.sessions?.forkSessionInStorage).toBeTypeOf('function');
    expect(agy().behavior.acp?.forkSessionInStorage).toBeTypeOf('function');
  });
});

describe('antigravity hooks.json(托管根,两条腿共用)', () => {
  it('写入器只拥有咕咕那一组:用户的组逐字保留、重写幂等;聊天面板腿代跑 Stop 时跳过咕咕的条目', async () => {
    const shadow = mkdtempSync(join(tmpdir(), 'agy-hooks-'));
    const fs = createLocalPluginFs(shadow);
    const userGroup = { Stop: [{ type: 'command', command: 'echo user' }] };
    await fs.write(ANTIGRAVITY_HOOKS_PATH, JSON.stringify({ mine: userGroup }));
    const hooks = buildAntigravityHookConfig();
    await hooks.writeHooks(fs);
    await hooks.writeHooks(fs);
    const written = JSON.parse((await fs.read(ANTIGRAVITY_HOOKS_PATH))!) as Record<string, Record<string, unknown[]>>;
    expect(written.mine).toEqual(userGroup);
    expect(Object.keys(written[ANTIGRAVITY_GUGU_HOOK_GROUP]!)).toEqual(['PreInvocation', 'Stop']);
    expect(isGuguHookText(JSON.stringify(written[ANTIGRAVITY_GUGU_HOOK_GROUP]))).toBe(true);
    expect(await hooks.getHooksInstalled(fs)).toBe(true);

    const commands = await loadStopCommands({
      cwd: shadow,
      env: { GEMINI_HOME: join(shadow, '.gemini') },
      homeDir: shadow,
    });
    expect(commands.map((command) => command.command)).toEqual(['echo user']);

    await hooks.deleteHooks(fs);
    expect(JSON.parse((await fs.read(ANTIGRAVITY_HOOKS_PATH))!)).toEqual({ mine: userGroup });
  });

  it('同名组不是咕咕写的 ⇒ 响亮拒绝,❌ 顶掉用户的组', async () => {
    const shadow = mkdtempSync(join(tmpdir(), 'agy-hooks-'));
    const fs = createLocalPluginFs(shadow);
    await fs.write(ANTIGRAVITY_HOOKS_PATH, JSON.stringify({ [ANTIGRAVITY_GUGU_HOOK_GROUP]: { Stop: [] } }));
    await expect(buildAntigravityHookConfig().writeHooks(fs)).rejects.toThrow(/not Gugu-owned/);
  });

  it('钩子命令两种执行法都能跑:终端腿交给 shell、聊天面板腿按词拆开直接 exec', () => {
    const script = `if [ -n "$GUGU_HOOK_PORT" ]; then echo on; else echo 'off'; fi`;
    const command = execSafeHookCommand(script);
    expect(command.startsWith("/bin/sh -c '")).toBe(true);
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
    // 终端腿:整行交给 shell
    expect(execFileSync('/bin/sh', ['-c', command], { env, encoding: 'utf8' }).trim()).toBe('off');
    // 聊天面板腿:按 POSIX 引号规则拆词后直接 exec —— 第一个词是 /bin/sh,脚本原样是 -c 的那一个参数
    const words = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${command}`], { encoding: 'utf8' }).split('\n');
    expect(words.slice(0, 3)).toEqual(['/bin/sh', '-c', script]);
    expect(execFileSync('/bin/sh', ['-c', script], { env, encoding: 'utf8' }).trim()).toBe('off');
  });

  it('PreInvocation 报完 session 再打出会话提示块:env 指向的档原样上 stdout,没有 env 就什么都不打', async () => {
    const shadow = mkdtempSync(join(tmpdir(), 'agy-hooks-'));
    const fs = createLocalPluginFs(shadow);
    await buildAntigravityHookConfig().writeHooks(fs);
    const written = JSON.parse((await fs.read(ANTIGRAVITY_HOOKS_PATH))!) as Record<string, Record<string, { command: string }[]>>;
    const command = written[ANTIGRAVITY_GUGU_HOOK_GROUP]!.PreInvocation![0]!.command;
    const contextFile = join(shadow, 'pre-invocation.json');
    writeFileSync(contextFile, '{"injectSteps":[{"ephemeralMessage":"IDENT"}]}');
    const base = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
    const payload = join(shadow, 'payload.json');
    writeFileSync(payload, '{"conversationId":"x"}');
    const run = (env: Record<string, string>) =>
      execFileSync('/bin/sh', ['-c', `${command} < "${payload}"`], { env, encoding: 'utf8' });
    expect(run({ ...base, [ANTIGRAVITY_INVOCATION_CONTEXT_ENV]: contextFile })).toBe('{"injectSteps":[{"ephemeralMessage":"IDENT"}]}');
    expect(run(base)).toBe('');
  });

  it('session 事件的原生 id 读 conversationId(驼峰),其余照通用解析', () => {
    const parse = buildAntigravityHookConfig().parseHookEvent;
    expect(parse('session', { conversationId: ' 69a90ddd-6692-44b5-90ef-d6ab9b801266 ' })).toEqual({
      kind: 'session',
      providerSessionId: '69a90ddd-6692-44b5-90ef-d6ab9b801266',
    });
    expect(parse('session', {})).toEqual({ kind: 'ignore' });
    expect(parse('stop', { conversationId: 'x' })).toMatchObject({ kind: 'status', type: 'stop' });
  });
});
