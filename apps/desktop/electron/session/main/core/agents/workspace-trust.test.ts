import path from 'node:path';
import type { ITrustBehavior } from '@gugu/session-core/agents/plugins';
import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceTrustService } from './workspace-trust';

const mockWarn = vi.hoisted(() => vi.fn());

vi.mock('@main/lib/logger', () => ({
  log: {
    warn: mockWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mocked so importing the module (which wires the singleton) stays free of
// DB and plugin-registry side effects; tests construct their own instances.
vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: { get: vi.fn() },
}));

vi.mock('./plugin-registry', () => ({
  getPlugin: vi.fn(() => ({ behavior: {} })),
}));

function makeService(overrides: {
  getSessionSettings?: () => Promise<{ autoTrustWorktrees: boolean }>;
  getTrustBehavior?: (providerId: AgentProviderId) => ITrustBehavior | undefined;
}): WorkspaceTrustService {
  return new WorkspaceTrustService({
    getSessionSettings: overrides.getSessionSettings ?? vi.fn(async () => ({ autoTrustWorktrees: true })),
    getTrustBehavior:
      overrides.getTrustBehavior ??
      vi.fn(() => ({
        channel: 'config-file' as const,
        trustWorkspace: vi.fn(async () => {}),
      })),
  });
}

describe('WorkspaceTrustService', () => {
  it('skips when auto-trust is disabled', async () => {
    const trustWorkspace = vi.fn();
    const service = makeService({
      getSessionSettings: vi.fn(async () => ({ autoTrustWorktrees: false })),
      getTrustBehavior: vi.fn(() => ({ channel: 'config-file' as const, trustWorkspace })),
    });

    await service.maybeAutoTrust({
      providerId: 'claude',
      workspacePath: '/tmp/worktree',
      host: { kind: 'local', homedir: '/home/local-user' },
    });

    expect(trustWorkspace).not.toHaveBeenCalled();
  });

  it('trusts when forced even if auto-trust is disabled', async () => {
    const trustWorkspace = vi.fn();
    const getSessionSettings = vi.fn(async () => ({ autoTrustWorktrees: false }));
    const service = makeService({
      getSessionSettings,
      getTrustBehavior: vi.fn(() => ({ channel: 'config-file' as const, trustWorkspace })),
    });

    await service.maybeAutoTrust({
      providerId: 'claude',
      workspacePath: '/tmp/worktree',
      host: { kind: 'local', homedir: '/home/local-user' },
      force: true,
    });

    expect(getSessionSettings).not.toHaveBeenCalled();
    expect(trustWorkspace).toHaveBeenCalledWith(expect.any(Object), {
      workspacePath: path.normalize('/tmp/worktree'),
      autoApprove: false,
    });
  });

  it('no-ops when the provider has no trust behavior', async () => {
    const getSessionSettings = vi.fn(async () => ({ autoTrustWorktrees: true }));
    const service = makeService({
      getSessionSettings,
      getTrustBehavior: vi.fn(() => undefined),
    });

    await service.maybeAutoTrust({
      providerId: 'claude',
      workspacePath: '/tmp/worktree',
      host: { kind: 'local', homedir: '/home/local-user' },
    });

    expect(getSessionSettings).not.toHaveBeenCalled();
  });

  it('refuses non-absolute workspace paths', async () => {
    const trustWorkspace = vi.fn();
    const service = makeService({
      getTrustBehavior: vi.fn(() => ({ channel: 'config-file' as const, trustWorkspace })),
    });

    await service.maybeAutoTrust({
      providerId: 'claude',
      workspacePath: 'relative/worktree',
      host: { kind: 'local', homedir: '/home/local-user' },
    });

    expect(trustWorkspace).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'WorkspaceTrust: refusing to auto-trust non-absolute workspace path',
      { path: 'relative/worktree' }
    );
  });

  it('logs and swallows trust behavior failures', async () => {
    const service = makeService({
      getTrustBehavior: vi.fn(() => ({
        channel: 'config-file' as const,
        trustWorkspace: vi.fn(async () => {
          throw new Error('boom');
        }),
      })),
    });

    await service.maybeAutoTrust({
      providerId: 'claude',
      workspacePath: '/tmp/worktree',
      host: { kind: 'local', homedir: '/home/local-user' },
    });

    expect(mockWarn).toHaveBeenCalledWith('WorkspaceTrust: failed to auto-trust worktree', {
      providerId: 'claude',
      path: path.normalize('/tmp/worktree'),
      error: 'Error: boom',
    });
  });

  it('runtime-env channel returns the env for the spawn', async () => {
    const trustEnv = vi.fn(() => ({ CLAUDE_CODE_SANDBOXED: '1', IS_DEMO: '1' }));
    const service = makeService({
      getTrustBehavior: vi.fn(() => ({ channel: 'runtime-env' as const, trustEnv })),
    });

    const outcome = await service.maybeAutoTrust({
      providerId: 'claude' as AgentProviderId,
      workspacePath: '/tmp/worktree',
      host: { kind: 'local', homedir: '/home/user' },
      autoApprove: true,
    });

    expect(outcome).toEqual({ env: { CLAUDE_CODE_SANDBOXED: '1', IS_DEMO: '1' }, args: [] });
    expect(trustEnv).toHaveBeenCalledWith({ workspacePath: '/tmp/worktree', autoApprove: true });
  });

  it('runtime-argv channel returns the argv for the spawn', async () => {
    const trustArgs = vi.fn(() => ['--trust']);
    const service = makeService({
      getTrustBehavior: vi.fn(() => ({ channel: 'runtime-argv' as const, trustArgs })),
    });

    const outcome = await service.maybeAutoTrust({
      providerId: 'mimocode' as AgentProviderId,
      workspacePath: '/tmp/worktree',
      host: { kind: 'local', homedir: '/home/user' },
      autoApprove: true,
    });

    expect(outcome).toEqual({ env: {}, args: ['--trust'] });
    expect(trustArgs).toHaveBeenCalledWith({ workspacePath: '/tmp/worktree', autoApprove: true });
  });

  it('runtime-argv channel yields no argv when auto-trust is off and not forced', async () => {
    // 反例:关着 auto-trust 时旗标不得出现 —— 这条红了说明「跳过信任门」不再受政策闸管。
    const trustArgs = vi.fn(() => ['--trust']);
    const service = makeService({
      getSessionSettings: vi.fn(async () => ({ autoTrustWorktrees: false })),
      getTrustBehavior: vi.fn(() => ({ channel: 'runtime-argv' as const, trustArgs })),
    });

    const outcome = await service.maybeAutoTrust({
      providerId: 'mimocode' as AgentProviderId,
      workspacePath: '/tmp/worktree',
      host: { kind: 'local', homedir: '/home/user' },
    });

    expect(outcome).toEqual({ env: {}, args: [] });
    expect(trustArgs).not.toHaveBeenCalled();
  });

  it('runtime-env channel yields an empty env when auto-trust is off and not forced', async () => {
    const trustEnv = vi.fn(() => ({ CLAUDE_CODE_SANDBOXED: '1', IS_DEMO: '1' }));
    const service = makeService({
      getSessionSettings: vi.fn(async () => ({ autoTrustWorktrees: false })),
      getTrustBehavior: vi.fn(() => ({ channel: 'runtime-env' as const, trustEnv })),
    });

    const outcome = await service.maybeAutoTrust({
      providerId: 'claude' as AgentProviderId,
      workspacePath: '/tmp/worktree',
      host: { kind: 'local', homedir: '/home/user' },
    });

    expect(outcome).toEqual({ env: {}, args: [] });
    expect(trustEnv).not.toHaveBeenCalled();
  });

  it('first-run-state channel yields nothing to the spawn', async () => {
    const service = makeService({
      getTrustBehavior: vi.fn(() => ({ channel: 'first-run-state' as const })),
    });

    const outcome = await service.maybeAutoTrust({
      providerId: 'kimi' as AgentProviderId,
      workspacePath: '/tmp/worktree',
      host: { kind: 'local', homedir: '/home/user' },
    });

    expect(outcome).toEqual({ env: {}, args: [] });
  });
});
