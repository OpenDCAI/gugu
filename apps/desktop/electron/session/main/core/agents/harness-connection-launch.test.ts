import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { composeAgentSpawnEnv } from '@gugu/session-core/agents/agent-run-context';
import { createHarnessConnectionSchema } from '@gugu/session-core/workspace-server/agent-config';
import { connectionLaunchConfig } from './harness-connection-launch';

describe('connection launch credentials', () => {
  it('keeps platform billing credentials above the selected local API connection', () => {
    const context = { cli: { kind: 'resolved' as const, path: 'claude' },
      env: { ANTHROPIC_API_KEY: 'inherited' }, unsetEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
      credentialEnv: { ANTHROPIC_AUTH_TOKEN: 'local-key', ANTHROPIC_BASE_URL: 'https://local.example' },
      configRootEnv: { CLAUDE_CONFIG_DIR: '/owned/relay/.claude' }, selfUpdateEnv: {}, extraArgs: [] };
    expect(composeAgentSpawnEnv(context).ANTHROPIC_AUTH_TOKEN).toBe('local-key');
    const platform = composeAgentSpawnEnv(context, { providerEnv: { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: 'http://platform-proxy' } });
    expect(platform).toMatchObject({ ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: 'http://platform-proxy', CLAUDE_CONFIG_DIR: '/owned/relay/.claude' });
    expect(JSON.stringify(platform)).not.toContain('local-key');
  });
  it('uses API-key authentication for Anthropic and bearer authentication for a compatible third-party API', () => {
    const official = connectionLaunchConfig('claude', 'official', 'api-key', '/owned/official', 'official-key');
    const relay = connectionLaunchConfig('claude', 'relay', 'api-key', '/owned/relay', 'relay-key', 'https://relay.example');
    expect(official.env.ANTHROPIC_API_KEY).toBe('official-key');
    expect(official.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(relay.env.ANTHROPIC_AUTH_TOKEN).toBe('relay-key');
    expect(relay.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
  it('removes inherited Claude credentials for an account and keeps host billing overrides authoritative', () => {
    const launch = connectionLaunchConfig('claude', 'work', 'account', '/owned/work');
    const context = {
      cli: { kind: 'resolved' as const, path: 'claude' },
      env: {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'old-key',
        ANTHROPIC_AUTH_TOKEN: 'old-token',
        CLAUDE_CODE_OAUTH_TOKEN: 'old-oauth',
        ANTHROPIC_BASE_URL: 'https://old.example',
      },
      configRootEnv: launch.env,
      unsetEnv: launch.unsetEnv,
      selfUpdateEnv: {},
      extraArgs: [],
    };
    expect(composeAgentSpawnEnv(context)).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/owned/work/.claude' });
    expect(
      composeAgentSpawnEnv(context, { hostInjections: [{ ANTHROPIC_API_KEY: 'platform' }] }).ANTHROPIC_API_KEY
    ).toBe('platform');
  });

  it.each([undefined, 'https://gateway.example/v1'])(
    'Codex uses an explicit Responses provider for API %s without persisting the key',
    (endpoint) => {
      const launch = connectionLaunchConfig('codex', 'work', 'api-key', '/owned/work', 'secret', endpoint);
      const config = parse(launch.config!);
      expect(config.model_provider).toBe('gugu_connection');
      expect(config.model_providers).toEqual({
        gugu_connection: {
          name: 'work',
          base_url: endpoint ?? 'https://api.openai.com/v1',
          env_key: 'OPENAI_API_KEY',
          wire_api: 'responses',
        },
      });
      expect(launch.config).not.toContain('secret');
      expect(launch.env).toEqual({ CODEX_HOME: '/owned/work/.codex', OPENAI_API_KEY: 'secret' });
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
