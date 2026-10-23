import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { composeAgentSpawnEnv } from '@gugu/session-core/agents/agent-run-context';
import { createHarnessConnectionSchema } from '@gugu/session-core/workspace-server/agent-config';
import { CLAUDE_CONNECTION_UNSET_ENV, claudeApiKeyEnv, codexApiKeyConnectionArgs } from './harness-connection-launch';

describe('connection launch credentials', () => {
  it('keeps platform billing credentials above the selected local API connection', () => {
    const context = { cli: { kind: 'resolved' as const, path: 'claude' },
      env: { ANTHROPIC_API_KEY: 'inherited' }, unsetEnv: [...CLAUDE_CONNECTION_UNSET_ENV],
      credentialEnv: claudeApiKeyEnv('local-key', 'https://local.example'), configRootEnv: {}, selfUpdateEnv: {}, extraArgs: [] };
    expect(composeAgentSpawnEnv(context).ANTHROPIC_AUTH_TOKEN).toBe('local-key');
    const platform = composeAgentSpawnEnv(context, { providerEnv: { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: 'http://platform-proxy' } });
    expect(platform).toMatchObject({ ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: 'http://platform-proxy' });
    expect(JSON.stringify(platform)).not.toContain('local-key');
  });
  it('uses API-key authentication for Anthropic and bearer authentication for a compatible third-party API', () => {
    expect(claudeApiKeyEnv('official-key')).toEqual({ ANTHROPIC_API_KEY: 'official-key' });
    expect(claudeApiKeyEnv('official-key', 'https://api.anthropic.com')).toEqual({ ANTHROPIC_API_KEY: 'official-key', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
    expect(claudeApiKeyEnv('relay-key', 'https://relay.example')).toEqual({ ANTHROPIC_AUTH_TOKEN: 'relay-key', ANTHROPIC_BASE_URL: 'https://relay.example' });
  });
  it('removes inherited Claude credentials for an account and keeps host billing overrides authoritative', () => {
    const context = {
      cli: { kind: 'resolved' as const, path: 'claude' },
      env: {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'old-key',
        ANTHROPIC_AUTH_TOKEN: 'old-token',
        CLAUDE_CODE_OAUTH_TOKEN: 'old-oauth',
        ANTHROPIC_BASE_URL: 'https://old.example',
      },
      unsetEnv: [...CLAUDE_CONNECTION_UNSET_ENV],
      configRootEnv: {},
      selfUpdateEnv: {},
      extraArgs: [],
    };
    expect(composeAgentSpawnEnv(context)).toEqual({ PATH: '/bin' });
    expect(
      composeAgentSpawnEnv(context, { hostInjections: [{ ANTHROPIC_API_KEY: 'platform' }] }).ANTHROPIC_API_KEY
    ).toBe('platform');
  });

  it.each([undefined, 'https://gateway.example/v1'])(
    'Codex API %s passes an explicit Responses provider as -c overrides, without the key',
    (endpoint) => {
      const args = codexApiKeyConnectionArgs('work', endpoint);
      const config = parse(args.filter((_, index) => index % 2 === 1).join('\n'));
      expect(args.filter((_, index) => index % 2 === 0).every((flag) => flag === '-c')).toBe(true);
      expect(config).toEqual({
        model_provider: 'gugu_connection',
        model_providers: {
          gugu_connection: {
            name: 'work',
            base_url: endpoint ?? 'https://api.openai.com/v1',
            env_key: 'OPENAI_API_KEY',
            wire_api: 'responses',
          },
        },
      });
      expect(args.join(' ')).not.toContain('secret');
    }
  );

  it('rejects incomplete API forms and endpoints containing credential material', () => {
    expect(createHarnessConnectionSchema.safeParse({ providerId: 'codex', kind: 'api-key' }).success).toBe(
      false
    );
    for (const endpoint of [
      'ftp://gateway.example',
      'https://user:pass@gateway.example',
      'https://gateway.example?key=secret',
    ]) {
      expect(
        createHarnessConnectionSchema.safeParse({
          providerId: 'codex',
          kind: 'api-key',
          apiKey: 'secret',
          endpoint,
        }).success
      ).toBe(false);
    }
  });
});
