import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/agent-hooks/agent-hook-service', () => ({
  agentHookService: { emitAgentEvent: vi.fn() },
}));
vi.mock('@main/core/settings/settings-service', () => ({ appSettingsService: { get: async () => ({}) } }));
vi.mock('@main/core/agents/agent-home', () => ({ resolveAgentHomeRoot: async () => '/unused' }));
// 一家把 hook 写进工作区 `.claude/settings.local.json` 的 harness(与 claude 同形)。
vi.mock('@main/core/agents/plugin-registry', () => ({
  getPlugin: () => ({
    capabilities: { hooks: { kind: 'config', scope: 'workspace' } },
    behavior: {
      hooks: {
        writeHooks: async (fs: { write(path: string, content: string): Promise<void> }) => {
          await fs.write('.claude/settings.local.json', '{}\n');
          return ['.claude/settings.local.json'];
        },
      },
    },
  }),
}));

import { HarnessStartupError, SessionRuntimeCompatibilityError } from '@gugu/session-core/agents/plugins';
import { JsonConfigParseError } from '@gugu/session-core/agents/plugins/helpers';
import type { Session } from '@shared/core/sessions/sessions';
import { ensureHooksInstalled } from '@main/core/agent-hooks/hook-config-service';
import {
  emitSessionSpawnFailure,
  findRuntimeVersionUnsupported,
  getRuntimeUpgradeRequirement,
  startupFailureForUser,
} from './spawn-failure';

// #6341 读数里 mac1 那一格:codex 0.147.0,会话页 TUI 腿(app-server)下界 0.153.0。
function versionTooOld(code: 'runtime-version-unsupported' | 'runtime-version-probe-failed' = 'runtime-version-unsupported') {
  return new SessionRuntimeCompatibilityError({
    code,
    providerId: 'codex',
    surface: 'app-server',
    installedVersion: code === 'runtime-version-unsupported' ? '0.147.0' : null,
    supportedFloor: '0.153.0',
    probe: { executable: '/opt/homebrew/bin/codex', args: ['--version'], output: 'codex-cli 0.147.0', failure: null, errno: null, pathEnv: null },
  });
}

/** 与 codex-app-server-delivery 的 describeCodexStartFailure 同形:原错误挂在 cause 上。 */
function wrappedLikeCodexStart(cause: unknown): Error {
  return new Error('Codex app-server 启动失败(/opt/homebrew/bin/codex):…', { cause });
}

function session(id: string): Session {
  return { id, providerId: 'codex', projectId: 'p', providerSessionId: null } as unknown as Session;
}

describe('findRuntimeVersionUnsupported', () => {
  it('finds the version block through the start-failure wrapper and an AggregateError', () => {
    const block = versionTooOld();
    expect(findRuntimeVersionUnsupported(wrappedLikeCodexStart(block))).toBe(block);
    expect(
      findRuntimeVersionUnsupported(new AggregateError([wrappedLikeCodexStart(block), new Error('cleanup')], 'both')),
    ).toBe(block);
  });

  it('does not treat other runtime-compatibility failures or plain errors as a version block', () => {
    expect(findRuntimeVersionUnsupported(wrappedLikeCodexStart(versionTooOld('runtime-version-probe-failed')))).toBeNull();
    expect(findRuntimeVersionUnsupported(new Error('thread not found'))).toBeNull();
  });
});

// #7103 谁拒绝谁说话:起任务失败到界面之前按层分。
describe('startupFailureForUser', () => {
  it('咕咕这一侧的故障(推理进程的传输超时、宿主自己的错)只交「咕咕这边出错了」的码,原文挂在 cause 上', () => {
    const timeout = new Error('request timed out: POST /session');
    const told = startupFailureForUser(timeout) as Error;
    expect(told.message).toBe('gugu-models:service-unavailable');
    expect(told.cause).toBe(timeout);
    const teardown = new AggregateError([new Error('roster binding not found'), new Error('teardown')], 'both failed');
    expect((startupFailureForUser(teardown) as Error).message).toBe('gugu-models:service-unavailable');
  });

  // Electron 按 error.toString() 把错交回渲染层 ⇒ 交出去的是普通 Error,那一句原样,类名不跟着上屏(评审 r4 G1)。
  it('harness 自己说的、已经带码的递那一句(包过一层也认得出),交出去的是普通 Error', () => {
    const said = (error: unknown) => String(startupFailureForUser(error));
    const codex = new HarnessStartupError('Codex app-server 启动失败(/opt/homebrew/bin/codex):找不到可执行文件');
    expect(said(codex)).toBe(`Error: ${codex.message}`);
    expect((startupFailureForUser(codex) as Error).cause).toBe(codex);
    expect(said(new AggregateError([codex, new Error('teardown')], 'both'))).toBe(`Error: ${codex.message}`);
    const block = versionTooOld();
    expect(said(wrappedLikeCodexStart(block))).toBe(`Error: ${block.message}`);
    expect(said(new Error('gugu-models:membership-required'))).toBe('Error: gugu-models:membership-required');
  });

  it('这家 harness 的配置文件坏了(用户自己的文件)是 harness 那一侧:递出哪个文件、什么错,❌ 说成咕咕出错', () => {
    const broken = new JsonConfigParseError('.claude/settings.local.json', 'InvalidSymbol at offset 28');
    expect(String(startupFailureForUser(broken))).toBe(
      'Error: Failed to parse .claude/settings.local.json: InvalidSymbol at offset 28'
    );
  });

  it('工作区写不进去(只读、没权限)也是用户环境那一侧:递出项目里哪个文件、系统原话,❌ 说成咕咕出错', async () => {
    const project = await mkdtemp(join(tmpdir(), 'gugu-hook-readonly-'));
    try {
      await chmod(project, 0o500);
      const failure = await ensureHooksInstalled({ providerId: 'claude', sessionPath: project, harnessVersion: null }).then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(HarnessStartupError);
      const told = String(startupFailureForUser(failure));
      expect(told).toMatch(/^Error: Could not write \.claude\/settings\.local\.json in this project: E(ACCES|PERM)\b/);
      expect(told).not.toContain('gugu-models:');
    } finally {
      await chmod(project, 0o700);
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe('emitSessionSpawnFailure → getRuntimeUpgradeRequirement', () => {
  it('records what the user needs to act on: required floor, installed version, and which copy', () => {
    emitSessionSpawnFailure(session('c1'), wrappedLikeCodexStart(versionTooOld()));
    expect(getRuntimeUpgradeRequirement('c1')).toEqual({
      providerId: 'codex',
      installedVersion: '0.147.0',
      supportedFloor: '0.153.0',
      executable: '/opt/homebrew/bin/codex',
    });
  });

  it('answers only for the latest failure: a later non-version failure clears it', () => {
    emitSessionSpawnFailure(session('c2'), wrappedLikeCodexStart(versionTooOld()));
    expect(getRuntimeUpgradeRequirement('c2')).not.toBeNull();
    emitSessionSpawnFailure(session('c2'), new Error('codex app-server endpoint 未在 15000ms 内就绪'));
    expect(getRuntimeUpgradeRequirement('c2')).toBeNull();
  });
});
