import { beforeEach, expect, it, vi } from 'vitest';

const helpers = vi.hoisted(() => ({ ensure: vi.fn() }));
vi.mock('@gugu/session-core/agents/plugins/helpers', () => ({
  resolveAgentHome: () => ({ envVar: 'CONFIG_HOME', configRoot: '/managed/config', shadowHome: '/managed' }),
  ensureAgentHome: helpers.ensure,
}));
vi.mock('@main/core/agents/plugin-registry', () => ({
  getPlugin: () => ({ capabilities: { sessionBundle: { injectionMode: 'managed-config-root', configRoot: {} } } }),
}));
beforeEach(() => { vi.resetModules(); helpers.ensure.mockReset(); });

it('shares a failed attempt, retries after repair, and keeps successful initialization cached', async () => {
  const error = new Error('configuration copy failed');
  helpers.ensure.mockRejectedValueOnce(error).mockResolvedValue(undefined);
  const home = await import('./agent-home');
  const failed = await Promise.allSettled([home.resolveAgentHomeEnv('antigravity'), home.resolveAgentHomeRoot('antigravity')]);
  expect(failed).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
  expect(helpers.ensure).toHaveBeenCalledTimes(1);
  expect(await home.resolveAgentHomeEnv('antigravity')).toEqual({ CONFIG_HOME: '/managed/config' });
  expect(await home.resolveAgentHomeRoot('antigravity')).toBe('/managed');
  expect(helpers.ensure).toHaveBeenCalledTimes(2);
});
