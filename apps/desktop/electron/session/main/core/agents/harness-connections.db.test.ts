import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';
import { sessions } from '@main/db/schema';

const state = vi.hoisted(() => ({ fixture: null as RegistryFixture | null, home: '', codexRoot: '', claudeRoot: '' }));
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
  alignCodexDefaultAccount,
  createHarnessConnection,
  listHarnessConnections,
  resolveHarnessConnection,
  selectHarnessConnection,
  removeHarnessConnection,
  sessionHarnessConnectionId,
} = await import('./harness-connections');

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'gugu-connections-'));
  // 「用户自己的配置根」一律指到临时目录:❌ 让测试读写跑测试那台机器上真实的 ~/.codex / ~/.claude。
  state.codexRoot = join(state.home, 'user', '.codex');
  state.claudeRoot = join(state.home, 'user', '.claude');
  vi.stubEnv('CODEX_HOME', state.codexRoot);
  vi.stubEnv('CLAUDE_CONFIG_DIR', state.claudeRoot);
  state.fixture = await openRegistryFixture('empty');
  state.fixture.sqlite.exec(`INSERT INTO projects (id, name, path) VALUES ('project', 'Project', '/repo');
    INSERT INTO sessions (id, project_id, title, provider, runtime, config)
    VALUES ('old', 'project', 'Existing', 'codex', 'pty', '{"version":"1","type":"pty"}');`);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  state.fixture?.close();
  state.fixture = null;
  await rm(state.home, { recursive: true, force: true });
});

function chatgptAuth(subject: string, refresh = 'r1'): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject, 'https://api.openai.com/auth': { chatgpt_account_id: 'ws' } })).toString('base64url');
  return JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: `h.${payload}.s`, refresh_token: refresh, account_id: 'ws' } });
}

async function writeAuthAt(root: string, text: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'auth.json'), text);
}

const vault = (id: string) => join(state.home, 'harness-connections', 'codex', id, '.codex');

it('saves API metadata without secrets and runs Codex sessions on the user root with env and -c overrides', async () => {
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
  for (const sessionId of ['old', undefined]) {
    const context = await resolveHarnessConnection('codex', sessionId ? { sessionId } : {});
    expect(context).toMatchObject({ connectionId: connection.id, credentialEnv: { OPENAI_API_KEY: 'test-secret' } });
    expect(context.configRootEnv).toBeUndefined();
    expect(context.credentialHome).toBeUndefined();
    expect(context.extraArgs).toContain('model_providers.gugu_connection.base_url="https://gateway.example/v1"');
    expect(JSON.stringify(context.extraArgs)).not.toContain('test-secret');
  }
  await expect(removeHarnessConnection('codex', connection.id)).rejects.toThrow('Select another');
  await selectHarnessConnection('codex', 'native');
  await removeHarnessConnection('codex', connection.id);
  expect(await listHarnessConnections('codex')).toEqual([
    { id: 'native', kind: 'native', name: '', current: true, endpoint: undefined },
  ]);
  expect((await resolveHarnessConnection('codex', { sessionId: 'old' })).connectionId).toBe('native');
  expect(state.fixture!.sqlite.prepare("SELECT config FROM sessions WHERE id = 'old'").get()).toEqual({
    config: '{"version":"1","type":"pty"}',
  });
});

it('switches Codex by moving credentials through the user root, keeping rotated tokens with their owner', async () => {
  await writeAuthAt(state.codexRoot, chatgptAuth('original'));
  const work = await createHarnessConnection({ providerId: 'codex', kind: 'account', name: 'Work' });
  await writeAuthAt(vault(work.id), chatgptAuth('work'));
  // 不在用户根里的账号:按连接问登录态时读它的保管目录。
  expect(await resolveHarnessConnection('codex', { connectionId: work.id })).toMatchObject({
    credentialHome: join(state.home, 'harness-connections', 'codex', work.id),
    configRootEnv: { CODEX_HOME: vault(work.id) },
  });

  await selectHarnessConnection('codex', work.id);
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('work'));
  expect(await readFile(join(vault('native'), 'auth.json'), 'utf8')).toBe(chatgptAuth('original'));
  const session = await resolveHarnessConnection('codex', { sessionId: 'old' });
  expect(session.connectionId).toBe(work.id);
  expect(session.configRootEnv).toBeUndefined();
  expect(await sessionHarnessConnectionId('old')).toBe(work.id);
  expect((await resolveHarnessConnection('codex', { connectionId: work.id })).configRootEnv).toBeUndefined();

  // CLI 在用户根里轮换了 refresh token:换走时这份新的要回到 Work 手里。
  await writeAuthAt(state.codexRoot, chatgptAuth('work', 'r2'));
  await selectHarnessConnection('codex', 'native');
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('original'));
  expect(await readFile(join(vault(work.id), 'auth.json'), 'utf8')).toBe(chatgptAuth('work', 'r2'));
  expect(await sessionHarnessConnectionId('old')).toBe('native');
  expect(await sessionHarnessConnectionId('deleted')).toBeUndefined();
});

it('can always switch back to the native Codex sign-in, even when the same account was also added as a connection', async () => {
  await writeAuthAt(state.codexRoot, chatgptAuth('original'));
  const same = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  await writeAuthAt(vault(same.id), chatgptAuth('original', 'r-same'));
  const other = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  await writeAuthAt(vault(other.id), chatgptAuth('other'));
  await selectHarnessConnection('codex', same.id);
  await selectHarnessConnection('codex', 'native');
  await selectHarnessConnection('codex', other.id);
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('other'));
  await selectHarnessConnection('codex', 'native');
  expect(JSON.parse(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).tokens.id_token).toBe(JSON.parse(chatgptAuth('original')).tokens.id_token);
});

it('keeps a copy of an unrecognized sign-in and refuses keychain-backed Codex credentials', async () => {
  await writeAuthAt(state.codexRoot, chatgptAuth('original'));
  const work = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  await writeAuthAt(vault(work.id), chatgptAuth('work'));
  await selectHarnessConnection('codex', work.id);
  await writeAuthAt(state.codexRoot, chatgptAuth('someone-else'));
  await selectHarnessConnection('codex', 'native');
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('original'));
  const backups = join(state.home, 'harness-connections', 'codex', 'unrecognized-sign-ins');
  const { readdir } = await import('node:fs/promises');
  const [backup] = await readdir(backups);
  expect(await readFile(join(backups, backup!), 'utf8')).toBe(chatgptAuth('someone-else'));

  await writeFile(join(state.codexRoot, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
  await expect(selectHarnessConnection('codex', work.id)).rejects.toThrow('keyring');
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('original'));
});

it('moves every Codex session, including ones pinned before the fix, onto the default subscription', async () => {
  const work = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  state.fixture!.sqlite.exec(`INSERT INTO sessions (id, project_id, title, provider, runtime, config, provider_session_id)
    VALUES ('ran', 'project', 'Ran', 'codex', 'acp', '{"version":"1","type":"acp","subscriptionConnectionId":"${work.id}"}', 'thread-1'),
           ('fork', 'project', 'Fork', 'codex', 'acp', '{"version":"1","type":"acp","forkedFrom":{"sessionId":"ran","title":"Ran"}}', NULL);`);
  for (const sessionId of ['ran', 'fork', 'old']) {
    const context = await resolveHarnessConnection('codex', { sessionId });
    expect(context.connectionId).toBe('native');
    expect(context.configRootEnv).toBeUndefined();
    expect(await sessionHarnessConnectionId(sessionId)).toBe('native');
  }
  expect((await resolveHarnessConnection('codex', { sessionId: 'runtime-view', sourceSessionId: 'ran' })).connectionId).toBe('native');
});

it('aligns the user root with a default account chosen before the fix, once and only for accounts', async () => {
  await writeAuthAt(state.codexRoot, chatgptAuth('original'));
  const work = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  await writeAuthAt(vault(work.id), chatgptAuth('work'));
  // 修复前的选择:只改了默认,凭据没进用户根。
  await state.fixture!.registry.setDefaultAccount('harness:codex', work.id);
  await alignCodexDefaultAccount();
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('work'));
  expect(await readFile(join(vault('native'), 'auth.json'), 'utf8')).toBe(chatgptAuth('original'));
  await writeAuthAt(state.codexRoot, chatgptAuth('work', 'r2'));
  await alignCodexDefaultAccount();
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('work', 'r2'));
  await state.fixture!.registry.setDefaultAccount('harness:codex', 'native');
  await alignCodexDefaultAccount();
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('work', 'r2'));
});

it('keeps Claude and Codex selections independent and never falls back when a bound connection is missing', async () => {
  const connection = await createHarnessConnection({ providerId: 'claude', kind: 'account', name: 'Work' });
  await selectHarnessConnection('claude', connection.id);
  expect((await resolveHarnessConnection('codex')).connectionId).toBe('native');
  await expect(resolveHarnessConnection('claude', { connectionId: 'missing' })).rejects.toThrow(
    'unavailable'
  );
});

it('binds legacy Claude sessions with a null config and ignores events for deleted sessions', async () => {
  state.fixture!.sqlite.exec(`INSERT INTO sessions (id, project_id, title, provider, runtime, config)
    VALUES ('legacy', 'project', 'Legacy', 'claude', 'pty', NULL);`);
  const connection = await createHarnessConnection({ providerId: 'claude', kind: 'account' });
  await selectHarnessConnection('claude', connection.id);
  expect((await resolveHarnessConnection('claude', { sessionId: 'legacy' })).connectionId).toBe('native');
  expect(await sessionHarnessConnectionId('legacy')).toBe('native');
  expect(await sessionHarnessConnectionId('deleted')).toBeUndefined();
});

it('keeps persistent and runtime-only Claude forks on their source connection after the default changes', async () => {
  const connection = await createHarnessConnection({ providerId: 'claude', kind: 'account' });
  await selectHarnessConnection('claude', connection.id);
  state.fixture!.sqlite.exec(`INSERT INTO sessions (id, project_id, title, provider, runtime, config)
    VALUES ('source', 'project', 'Source', 'claude', 'acp', '{"version":"1","type":"acp"}');`);
  await resolveHarnessConnection('claude', { sessionId: 'source' });
  await selectHarnessConnection('claude', 'native');
  state.fixture!.sqlite.exec(`INSERT INTO sessions (id, project_id, title, provider, runtime, config)
    VALUES ('fork', 'project', 'Fork', 'claude', 'acp', '{"version":"1","type":"acp","forkedFrom":{"sessionId":"source","title":"Source"}}');`);
  expect((await resolveHarnessConnection('claude', { sessionId: 'fork' })).connectionId).toBe(connection.id);
  expect((await resolveHarnessConnection('claude', { sessionId: 'runtime-view', sourceSessionId: 'source' })).connectionId).toBe(connection.id);
  await selectHarnessConnection('claude', connection.id);
  expect(await sessionHarnessConnectionId('fork')).toBe(connection.id);
});

it('Claude account/API changes preserve both PTY and ACP session bindings', async () => {
  const account = await createHarnessConnection({ providerId: 'claude', kind: 'account' });
  const api = await createHarnessConnection({ providerId: 'claude', kind: 'api-key', apiKey: 'fixture-key', endpoint: 'https://relay.example/v1' });
  await selectHarnessConnection('claude', account.id);
  for (const runtime of ['pty', 'acp'] as const) {
    await state.fixture!.db.insert(sessions).values({ id: runtime, projectId: 'project', title: runtime, provider: 'claude', runtime, config: { version: '1', type: runtime } });
    expect((await resolveHarnessConnection('claude', { sessionId: runtime })).connectionId).toBe(account.id);
  }
  await selectHarnessConnection('claude', api.id);
  const apiContext = await resolveHarnessConnection('claude');
  expect(apiContext.connectionId).toBe(api.id);
  expect(apiContext.credentialEnv).toHaveProperty('ANTHROPIC_AUTH_TOKEN', 'fixture-key');
  for (const runtime of ['pty', 'acp']) {
    const resumed = await resolveHarnessConnection('claude', { sessionId: runtime });
    expect(resumed.connectionId).toBe(account.id);
    expect(resumed.configRootEnv).not.toEqual(apiContext.configRootEnv);
    expect(JSON.stringify(resumed)).not.toContain('fixture-key');
  }
  await selectHarnessConnection('claude', 'native');
  for (const runtime of ['pty', 'acp']) expect((await resolveHarnessConnection('claude', { sessionId: runtime })).connectionId).toBe(account.id);
});

it('gives a Claude connection root the user settings and MCP servers while keeping its own sign-in', async () => {
  await mkdir(state.claudeRoot, { recursive: true });
  await writeFile(join(state.claudeRoot, 'settings.json'), '{"autoCompactWindow":500000}');
  await writeFile(join(state.claudeRoot, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me' }, mcpServers: { docs: { command: 'docs' } } }));
  const connection = await createHarnessConnection({ providerId: 'claude', kind: 'account' });
  const context = await resolveHarnessConnection('claude', { connectionId: connection.id });
  const root = context.configRootEnv!.CLAUDE_CONFIG_DIR!;
  expect(await readlink(join(root, 'settings.json'))).toBe(join(state.claudeRoot, 'settings.json'));
  const own = JSON.parse(await readFile(join(root, '.claude.json'), 'utf8')) as Record<string, unknown>;
  expect(own).toEqual({ mcpServers: { docs: { command: 'docs' } } });
  expect((await lstat(join(root, 'settings.json'))).isSymbolicLink()).toBe(true);
});
