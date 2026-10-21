import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  SessionCapabilityBundle,
  SessionMaterializationContext,
} from '@gugu/session-core/agents/plugins';
import { materializeCodebuddySessionBundle } from './session-bundle';

const platform = { baseUrl: 'https://relay.example/v1', apiKey: 'tok-123' };

function bundle(overrides: Partial<SessionCapabilityBundle> = {}): SessionCapabilityBundle {
  return {
    mcpServers: [
      { name: 'gugu', transport: 'http', url: 'http://127.0.0.1:4100/mcp', authorizationEnv: 'GUGU_SESSION_MCP_AUTH_GUGU', alwaysLoad: true },
      { name: 'mine', transport: 'stdio', command: 'node', args: ['srv.js'], env: { TOKEN: 'MY_TOKEN' } },
    ],
    env: { GUGU_HOME: '/gugu-home', GUGU_SESSION_MCP_AUTH_GUGU: 'Bearer mcp-secret', MY_TOKEN: 'user-secret' },
    model: null,
    autonomy: null,
    promptBlocks: { platform: '<gugu_platform>p</gugu_platform>', identity: '<agent_identity>i</agent_identity>' },
    ...overrides,
  } as SessionCapabilityBundle;
}

// 工作目录经一层软链给出:信任那一格要的是 realpath(它拿 `process.cwd()` 比对)。
const scratch = mkdtempSync(join(tmpdir(), 'codebuddy-bundle-'));
const realCwd = join(realpathSync(scratch), 'work');
const linkedCwd = join(scratch, 'linked');
mkdirSync(realCwd);
symlinkSync(realCwd, linkedCwd);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ctx = (surface: 'acp' | 'tui') => ({ surface, lifecycle: 'fresh', cwd: linkedCwd }) as SessionMaterializationContext;

describe('CodeBuddy 会话包:聊天面板(ACP)腿', () => {
  it('咕咕那台带 `_meta.defer_loading:false`,用户自己的不带;令牌随条目走,不留在进程环境', () => {
    const result = materializeCodebuddySessionBundle(ctx('acp'), bundle());
    const [gugu, mine] = result.acp!.mcpServers as unknown as ReadonlyArray<Record<string, unknown>>;
    expect(gugu).toMatchObject({ type: 'http', name: 'gugu', _meta: { defer_loading: false } });
    expect(gugu.headers).toEqual([{ name: 'Authorization', value: 'Bearer mcp-secret' }]);
    expect(mine).not.toHaveProperty('_meta');
    expect(result.env).not.toHaveProperty('GUGU_SESSION_MCP_AUTH_GUGU');
  });

  it('身份自述走 session-context(厂商原生 ACP server 不读 `_meta.systemPrompt`)', () => {
    const result = materializeCodebuddySessionBundle(ctx('acp'), bundle());
    expect(result.prompt).toEqual({
      value: '<gugu_platform>p</gugu_platform><agent_identity>i</agent_identity>',
      delivered: ['platform', 'identity'],
      carrier: 'session-context',
    });
    expect(result.argsAppend).not.toContain('--append-system-prompt');
  });

  it('非平台会话一个模型键都不发,也不挂 `--settings`', () => {
    const result = materializeCodebuddySessionBundle(ctx('acp'), bundle());
    expect(result.argsAppend).toEqual([]);
    expect(result.artifacts).toEqual([]);
    expect(result.report.units.model.status).toBe('degraded');
    const half = materializeCodebuddySessionBundle(
      ctx('acp'),
      bundle({ model: { dialect: 'codebuddy-settings-env', model: 'glm-5.3' } }),
    );
    expect(half.argsAppend).toEqual([]);
  });

  it('平台会话:0600 settings 文档(地址 + 各槽位钉同一个模型)+ `--settings <路径>`;令牌只进进程环境', () => {
    const result = materializeCodebuddySessionBundle(
      ctx('acp'),
      bundle({ model: { dialect: 'codebuddy-settings-env', model: 'glm-5.3', platformProvider: platform } }),
    );
    expect(result.artifacts).toHaveLength(1);
    const [doc] = result.artifacts;
    expect(doc.mode).toBe(0o600);
    expect(doc.path.startsWith('/gugu-home/runtime-sessions/codebuddy-capability-runs/')).toBe(true);
    expect(result.argsAppend).toEqual(['--settings', doc.path]);
    expect(JSON.parse(doc.content)).toEqual({
      env: {
        CODEBUDDY_BASE_URL: 'https://relay.example/v1',
        CODEBUDDY_MODEL: 'glm-5.3',
        CODEBUDDY_SMALL_FAST_MODEL: 'glm-5.3',
        CODEBUDDY_BIG_SLOW_MODEL: 'glm-5.3',
        CODEBUDDY_CODE_SUBAGENT_MODEL: 'glm-5.3',
      },
    });
    expect(result.argsAppend.join(' ')).not.toContain('tok-123');
    // 令牌只在进程环境:CodeBuddy 会把 settings 文档整份打进它的日志。
    expect(doc.content).not.toContain('tok-123');
    expect(result.env.CODEBUDDY_API_KEY).toBe('tok-123');
    expect(result.report.units.model.status).toBe('loaded');
  });

  it('别家的方言响亮拒绝', () => {
    expect(() => materializeCodebuddySessionBundle(
      ctx('acp'),
      bundle({ model: { dialect: 'qoder-byok-settings', model: 'x', platformProvider: platform } }),
    )).toThrow(/cannot materialize model dialect 'qoder-byok-settings'/);
  });
});

describe('CodeBuddy 会话包:终端腿', () => {
  it('MCP 走 0600 `--mcp-config` 文件,值只写 `${VAR}` 引用;咕咕那台 alwaysLoad', () => {
    const result = materializeCodebuddySessionBundle(ctx('tui'), bundle());
    const mcpIndex = result.argsAppend.indexOf('--mcp-config');
    expect(mcpIndex).toBeGreaterThanOrEqual(0);
    const doc = result.artifacts.find((artifact) => artifact.path === result.argsAppend[mcpIndex + 1])!;
    expect(doc.mode).toBe(0o600);
    expect(doc.content).not.toContain('mcp-secret');
    expect(doc.content).not.toContain('user-secret');
    expect(JSON.parse(doc.content)).toEqual({
      mcpServers: {
        gugu: {
          type: 'http',
          url: 'http://127.0.0.1:4100/mcp',
          headers: { Authorization: '${GUGU_SESSION_MCP_AUTH_GUGU}' },
          alwaysLoad: true,
        },
        mine: { type: 'stdio', command: 'node', args: ['srv.js'], env: { TOKEN: '${MY_TOKEN}' } },
      },
    });
    // 展开靠子进程环境:引用的那两个键必须还在。
    expect(result.env.GUGU_SESSION_MCP_AUTH_GUGU).toBe('Bearer mcp-secret');
    expect(result.acp).toBeUndefined();
  });

  it('身份自述走 `--append-system-prompt <正文>`', () => {
    const result = materializeCodebuddySessionBundle(ctx('tui'), bundle());
    const at = result.argsAppend.indexOf('--append-system-prompt');
    expect(result.argsAppend[at + 1]).toBe('<gugu_platform>p</gugu_platform><agent_identity>i</agent_identity>');
    expect(result.prompt).toBeUndefined();
  });

  it('主 agent 钉成 cli(与 ACP 腿同一个);ACP 腿不带这个旗标', () => {
    const tui = materializeCodebuddySessionBundle(ctx('tui'), bundle());
    const at = tui.argsAppend.indexOf('--agent');
    expect(tui.argsAppend.slice(at, at + 2)).toEqual(['--agent', 'cli']);
    expect(materializeCodebuddySessionBundle(ctx('acp'), bundle()).argsAppend).not.toContain('--agent');
  });

  it('工作目录按次标成可信:realpath 写进同一份 0600 `--settings` 文档,与平台模型并排', () => {
    const own = materializeCodebuddySessionBundle(ctx('tui'), bundle());
    const ownAt = own.argsAppend.indexOf('--settings');
    const ownDoc = own.artifacts.find((artifact) => artifact.path === own.argsAppend[ownAt + 1])!;
    expect(ownDoc.mode).toBe(0o600);
    expect(JSON.parse(ownDoc.content)).toEqual({ trustedDirectories: [realCwd] });

    const platformRun = materializeCodebuddySessionBundle(
      ctx('tui'),
      bundle({ model: { dialect: 'codebuddy-settings-env', model: 'glm-5.3', platformProvider: platform } }),
    );
    expect(platformRun.argsAppend.filter((arg) => arg === '--settings')).toHaveLength(1);
    const doc = platformRun.artifacts.find((artifact) => artifact.path.endsWith('gugu-session-settings.json'))!;
    expect(JSON.parse(doc.content)).toMatchObject({ env: { CODEBUDDY_MODEL: 'glm-5.3' }, trustedDirectories: [realCwd] });
  });
});
