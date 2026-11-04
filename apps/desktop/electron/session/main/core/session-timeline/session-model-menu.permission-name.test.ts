import { expect, it, vi } from 'vitest';
import { readSessionPermissionAgentName } from './session-model-menu';

vi.mock('@main/core/agents/plugin-registry', () => ({
  listPlugins: () => [
    { metadata: { id: 'codex', name: 'Codex' } },
    { metadata: { id: 'hermes', name: 'Hermes Agent' } },
  ],
}));
vi.mock('@main/core/agents/controller', () => {
  throw new Error('Reading a permission label must not load installation probes');
});

it.each([
  ['codex', 'Codex'],
  ['hermes', 'Hermes Agent'],
  ['unregistered-provider', 'unregistered-provider'],
])('reads provider %s metadata without probing installations', async (id, name) => {
  expect(await readSessionPermissionAgentName(id)).toBe(name);
});
