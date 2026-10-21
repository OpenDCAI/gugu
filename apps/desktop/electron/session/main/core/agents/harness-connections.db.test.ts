import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';
import { sessions } from '@main/db/schema';

const state = vi.hoisted(() => ({ fixture: null as RegistryFixture | null, home: '' }));
vi.mock('@main/db/client', () => ({
  get db() {
    return state.fixture!.db;
  },
}));
vi.mock('@main/core/provider-accounts/provider-account-registry-instance', () => ({
  get providerAccountRegistry() {
    return state.fixture!.registry;
  },
}));
vi.mock('electron', () => ({ app: { getPath: () => state.home } }));
const {
  createHarnessConnection,
  listHarnessConnections,
  resolveHarnessConnection,
  selectHarnessConnection,
  removeHarnessConnection,
  sessionHarnessConnectionId,
} = await import('./harness-connections');

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'gugu-connections-'));
  state.fixture = await openRegistryFixture('empty');
  state.fixture.sqlite.exec(`INSERT INTO projects (id, name, path) VALUES ('project', 'Project', '/repo');
    INSERT INTO sessions (id, project_id, title, provider, runtime, config)
    VALUES ('old', 'project', 'Existing', 'codex', 'pty', '{"version":"1","type":"pty"}');`);
});
afterEach(async () => {
  state.fixture?.close();
  state.fixture = null;
  await rm(state.home, { recursive: true, force: true });
});

it('saves metadata without returning secrets, isolates credentials, and pins both existing and new sessions across switches', async () => {
  const connection = await createHarnessConnection({
    providerId: 'codex',
    kind: 'api-key',
    apiKey: 'test-secret',
    endpoint: 'https://gateway.example/v1',
  });
  expect(JSON.stringify(await listHarnessConnections('codex'))).not.toContain('test-secret');
  expect(
    state
      .fixture!.sqlite.prepare('SELECT meta FROM provider_accounts')
      .all()
      .map((row) => JSON.stringify(row))
      .join('')
  ).not.toContain('test-secret');
  await selectHarnessConnection('codex', connection.id);
  const old = await resolveHarnessConnection('codex', { sessionId: 'old' });
  expect(old.connectionId).toBe('native');
  state.fixture!.sqlite.exec(`INSERT INTO sessions (id, project_id, title, provider, runtime, config)
    VALUES ('new', 'project', 'New', 'codex', 'acp', '{"version":"1","type":"acp"}');`);
  const fresh = await resolveHarnessConnection('codex', { sessionId: 'new' });
  expect(fresh).toMatchObject({
    connectionId: connection.id,
    credentialEnv: { OPENAI_API_KEY: 'test-secret' },
  });
  const configDir = fresh.configRootEnv!.CODEX_HOME;
  expect((await stat(configDir)).mode & 0o777).toBe(0o700);
  expect(await readFile(join(configDir, 'config.toml'), 'utf8')).not.toContain('test-secret');
  await expect(removeHarnessConnection('codex', connection.id)).rejects.toThrow('Select another');
  await selectHarnessConnection('codex', 'native');
  await removeHarnessConnection('codex', connection.id);
  expect(await listHarnessConnections('codex')).toEqual([
    { id: 'native', kind: 'native', name: '', current: true, endpoint: undefined },
  ]);
  expect((await resolveHarnessConnection('codex', { sessionId: 'new' })).connectionId).toBe(connection.id);
  expect((await resolveHarnessConnection('codex')).connectionId).toBe('native');
});

it('keeps Claude and Codex selections independent and never falls back when a bound connection is missing', async () => {
  const connection = await createHarnessConnection({ providerId: 'claude', kind: 'account', name: 'Work' });
  await selectHarnessConnection('claude', connection.id);
  expect((await resolveHarnessConnection('codex')).connectionId).toBe('native');
  await expect(resolveHarnessConnection('claude', { connectionId: 'missing' })).rejects.toThrow(
    'unavailable'
  );
});


it('binds legacy sessions with a null config and ignores events for deleted sessions', async () => {
  state.fixture!.sqlite.exec(`INSERT INTO sessions (id, project_id, title, provider, runtime, config)
    VALUES ('legacy', 'project', 'Legacy', 'codex', 'pty', NULL);`);
  const connection = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  await selectHarnessConnection('codex', connection.id);
  expect((await resolveHarnessConnection('codex', { sessionId: 'legacy' })).connectionId).toBe('native');
  expect(sessionHarnessConnectionId('legacy')).toBe('native');
  expect(sessionHarnessConnectionId('deleted')).toBeUndefined();
});

it('keeps persistent and runtime-only forks on their source connection after the default changes', async () => {
  const connection = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  await selectHarnessConnection('codex', connection.id);
  state.fixture!.sqlite.exec(`INSERT INTO sessions (id, project_id, title, provider, runtime, config)
    VALUES ('source', 'project', 'Source', 'codex', 'acp', '{"version":"1","type":"acp"}');`);
  await resolveHarnessConnection('codex', { sessionId: 'source' });
  await selectHarnessConnection('codex', 'native');
  state.fixture!.sqlite.exec(`INSERT INTO sessions (id, project_id, title, provider, runtime, config)
    VALUES ('fork', 'project', 'Fork', 'codex', 'acp', '{"version":"1","type":"acp","forkedFrom":{"sessionId":"source","title":"Source"}}');`);
  expect((await resolveHarnessConnection('codex', { sessionId: 'fork' })).connectionId).toBe(connection.id);
  expect((await resolveHarnessConnection('codex', { sessionId: 'runtime-view', sourceSessionId: 'source' })).connectionId).toBe(connection.id);
  await selectHarnessConnection('codex', connection.id);
  expect(sessionHarnessConnectionId('fork')).toBe(connection.id);
});

it.each(['claude', 'codex'] as const)('%s account/API changes preserve both PTY and ACP session bindings', async (providerId) => {
  const account = await createHarnessConnection({ providerId, kind: 'account' });
  const api = await createHarnessConnection({ providerId, kind: 'api-key', apiKey: 'fixture-key', endpoint: 'https://relay.example/v1' });
  await selectHarnessConnection(providerId, account.id);
  for (const runtime of ['pty', 'acp'] as const) {
    await state.fixture!.db.insert(sessions).values({ id: runtime, projectId: 'project', title: runtime, provider: providerId, runtime, config: { version: '1', type: runtime } });
    expect((await resolveHarnessConnection(providerId, { sessionId: runtime })).connectionId).toBe(account.id);
  }
  await selectHarnessConnection(providerId, api.id);
  const apiContext = await resolveHarnessConnection(providerId);
  expect(apiContext.connectionId).toBe(api.id);
  expect(apiContext.credentialEnv).toHaveProperty(providerId === 'claude' ? 'ANTHROPIC_AUTH_TOKEN' : 'OPENAI_API_KEY', 'fixture-key');
  for (const runtime of ['pty', 'acp']) {
    const resumed = await resolveHarnessConnection(providerId, { sessionId: runtime });
    expect(resumed.connectionId).toBe(account.id);
    expect(resumed.configRootEnv).not.toEqual(apiContext.configRootEnv);
    expect(JSON.stringify(resumed)).not.toContain('fixture-key');
  }
  await selectHarnessConnection(providerId, 'native');
  for (const runtime of ['pty', 'acp']) expect((await resolveHarnessConnection(providerId, { sessionId: runtime })).connectionId).toBe(account.id);
});
