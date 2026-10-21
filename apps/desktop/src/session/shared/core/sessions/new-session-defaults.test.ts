import { describe, expect, it } from 'vitest';
import { newSessionMemorySchema } from '../../../../../electron/session/main/core/settings/schema';
import { SETTINGS_DEFAULTS } from '../../../../../electron/session/main/core/settings/settings-registry';
import { resolveSessionProviderSelection } from './provider-selection';
import { DEFAULT_SESSION_VIEW } from './new-session-defaults';
import { asAgentProviderId } from '@gugu/session-plugins/agents/types';

const claude = asAgentProviderId('claude');
const codex = asAgentProviderId('codex');
const choose = (overrides = {}) => resolveSessionProviderSelection({
  defaultProviderId: null, providerOverride: null, knownProviderIds: [codex, claude],
  installedProviderIds: [codex, claude], availabilityKnown: true, ...overrides,
});

describe('first-use defaults (#7582)', () => {
  it('uses general mode consistently without overwriting a saved code choice', () => {
    expect(newSessionMemorySchema.parse(undefined).sessionView).toBe(DEFAULT_SESSION_VIEW);
    expect(newSessionMemorySchema.parse({}).sessionView).toBe('general');
    expect(SETTINGS_DEFAULTS.newSessionMemory.sessionView).toBe('general');
    expect(newSessionMemorySchema.parse({ sessionView: 'code' }).sessionView).toBe('code');
  });
  it('prefers available Codex but keeps personal Claude choices', () => {
    expect(choose().providerId).toBe(codex);
    expect(choose({ rememberedProviderId: claude }).providerId).toBe(claude);
    expect(choose({ defaultProviderId: claude }).providerId).toBe(claude);
    expect(choose({ providerOverride: codex }).providerId).toBe(codex);
    expect(choose({ installedProviderIds: [codex] }).providerId).toBe(codex);
    expect(choose({ installedProviderIds: [] }).providerId).toBeNull();
  });
});
