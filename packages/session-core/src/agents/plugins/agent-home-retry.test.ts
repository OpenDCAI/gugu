import { expect, it, vi } from 'vitest';
import { NodeExecutionContext } from '../../exec';
import { createScope } from '@gugu/session-wire/util';
import { noopLogger } from '@gugu/session-shared/logger';
import { AgentPluginHost } from './plugin-host';
import type { CLIAgentPluginProvider } from './index';
import { createPluginRegistry } from '@gugu/session-shared/plugins';
import { createLocalPluginFs } from './helpers/local-plugin-fs';
import type { ResolvedAgentHome } from './capabilities/config-root';

it('retries a rejected provider home while sharing concurrent work and caching success', async () => {
  const scope = createScope({ label: 'home-retry', logger: noopLogger });
  const registry = createPluginRegistry<CLIAgentPluginProvider>();
  registry.register({ metadata: { id: 'broken' }, capabilities: {
    sessionBundle: { injectionMode: 'managed-config-root', configRoot: {} },
  } } as CLIAgentPluginProvider);
  vi.spyOn(registry, 'getAll').mockReturnValue([]);
  const home: ResolvedAgentHome = { providerId: 'broken', envVar: 'CONFIG_HOME',
    shadowHome: '/managed', configRoot: '/managed/config', userConfigRoot: '/user/config', carryExclusions: [], seedFiles: [] };
  const first = Promise.withResolvers<ResolvedAgentHome | null>();
  const provision = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(home);
  const fs = createLocalPluginFs('/unused');
  const host = new AgentPluginHost({ scope, registry, fs, homeDir: '/user',
    exec: new NodeExecutionContext({ env: { PATH: '/bin' } }),
    agentHome: { provision, createFs: () => fs },
  });
  try {
    const pending = Promise.allSettled([host.homeDirFor('broken'), host.fsFor('broken')]);
    first.reject(new Error('copy failed'));
    expect((await pending).every(result => result.status === 'rejected')).toBe(true);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(await host.homeDirFor('broken')).toBe('/managed');
    expect(await host.fsFor('broken')).toBe(fs);
    expect(provision).toHaveBeenCalledTimes(2);
  } finally { await scope.dispose(); }
});
