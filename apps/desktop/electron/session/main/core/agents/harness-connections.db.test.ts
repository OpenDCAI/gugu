import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';

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
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
// Claude 凭据一律走文件:❌ 让测试读写跑测试那台机器的登录钥匙串。
vi.mock('./claude-credential-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claude-credential-store')>();
  return { ...actual, createClaudeCredentialStore: () => actual.createClaudeCredentialStore({ platform: 'linux' }) };
});
const {
  alignClaudeConnections,
  alignCodexDefaultAccount,
  assertHarnessConnectionSelectable,
  connectionConfigRoot,
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
    INSERT INTO sessions (id, project_id, provider, runtime, config)
    VALUES ('old', 'project', 'codex', 'pty', '{"version":"1","type":"pty"}');`);
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
  state.fixture!.sqlite.exec(`INSERT INTO sessions (id, project_id, provider, runtime, config, provider_session_id)
    VALUES ('ran', 'project', 'codex', 'acp', '{"version":"1","type":"acp","subscriptionConnectionId":"${work.id}"}', 'thread-1'),
           ('fork', 'project', 'codex', 'acp', '{"version":"1","type":"acp","forkedFrom":{"sessionId":"ran","title":"Ran"}}', NULL);`);
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

it('files a first Codex account under its own connection when native never had a sign-in', async () => {
  const first = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  const second = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  await writeAuthAt(vault(first.id), chatgptAuth('first'));
  await writeAuthAt(vault(second.id), chatgptAuth('second'));
  await selectHarnessConnection('codex', first.id);
  await writeAuthAt(state.codexRoot, chatgptAuth('first', 'r2'));
  await selectHarnessConnection('codex', second.id);
  // 轮换过的 token 回到 first 手里,❌ 被存到「原生」名下。
  expect(await readFile(join(vault(first.id), 'auth.json'), 'utf8')).toBe(chatgptAuth('first', 'r2'));
  await expect(stat(join(vault('native'), 'auth.json'))).rejects.toThrow();
  await selectHarnessConnection('codex', first.id);
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('first', 'r2'));
});

it('keeps a first Codex account’s rotated token with it after a detour through an API connection', async () => {
  const first = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  const second = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  const api = await createHarnessConnection({ providerId: 'codex', kind: 'api-key', apiKey: 'fixture-key' });
  await writeAuthAt(vault(first.id), chatgptAuth('first'));
  await writeAuthAt(vault(second.id), chatgptAuth('second'));
  await selectHarnessConnection('codex', first.id);
  await selectHarnessConnection('codex', api.id);
  // API 连接上跑着的时候,用户根里仍是 first,CLI 照样会轮换它的 token。
  await writeAuthAt(state.codexRoot, chatgptAuth('first', 'r2'));
  await selectHarnessConnection('codex', second.id);
  expect(await readFile(join(vault(first.id), 'auth.json'), 'utf8')).toBe(chatgptAuth('first', 'r2'));
  await expect(stat(join(vault('native'), 'auth.json'))).rejects.toThrow();
});

it('checks a switch before anything is stopped: a missing sign-in or keychain storage is refused up front', async () => {
  await writeAuthAt(state.codexRoot, chatgptAuth('original'));
  const work = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  const api = await createHarnessConnection({ providerId: 'codex', kind: 'api-key', apiKey: 'fixture-key' });
  await expect(assertHarnessConnectionSelectable('codex', work.id)).rejects.toThrow('no saved sign-in');
  await writeAuthAt(vault(work.id), chatgptAuth('work'));
  await assertHarnessConnectionSelectable('codex', work.id);
  await assertHarnessConnectionSelectable('codex', 'native');
  await assertHarnessConnectionSelectable('codex', api.id);
  await expect(assertHarnessConnectionSelectable('codex', 'missing')).rejects.toThrow('no longer exists');
  await writeFile(join(state.codexRoot, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
  await expect(assertHarnessConnectionSelectable('codex', work.id)).rejects.toThrow('keyring');
  // 只是预检:用户根原样。
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('original'));

  await writeClaudeSignIn(state.claudeRoot, 'u-original', claudeCredential('original', 100));
  const empty = await createHarnessConnection({ providerId: 'claude', kind: 'account' });
  await expect(assertHarnessConnectionSelectable('claude', empty.id)).rejects.toThrow('no saved sign-in');
  await writeClaudeSignIn(claudeVault(empty.id), 'u-work', claudeCredential('work', 200));
  await assertHarnessConnectionSelectable('claude', empty.id);
  await assertHarnessConnectionSelectable('claude', 'native');
});

const claudeVault = (id: string) => join(state.home, 'harness-connections', 'claude', id, '.claude');
const claudeCredential = (access: string, expiresAt: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: `r-${access}`, expiresAt }, ...extra });
const accessAt = async (root: string) =>
  (JSON.parse(await readFile(join(root, '.credentials.json'), 'utf8')) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken;
const accountAt = async (root: string) =>
  (JSON.parse(await readFile(join(root, '.claude.json'), 'utf8')) as { oauthAccount: { accountUuid: string } }).oauthAccount.accountUuid;

async function writeClaudeSignIn(root: string, uuid: string, credential: string, config: Record<string, unknown> = {}): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, '.credentials.json'), credential);
  await writeFile(join(root, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuid }, hasCompletedOnboarding: true, ...config }));
}

it('switches Claude by moving the sign-in through the user root and runs every session there on the default', async () => {
  await writeClaudeSignIn(state.claudeRoot, 'u-original', claudeCredential('original', 100, { mcpOAuth: { docs: 'kept' } }), {
    projects: { '/repo': { allowedTools: ['Bash'] } },
  });
  const work = await createHarnessConnection({ providerId: 'claude', kind: 'account', name: 'Work' });
  await writeClaudeSignIn(claudeVault(work.id), 'u-work', claudeCredential('work', 200));
  // 不在用户根里的账号:按连接问登录态时读它的保管目录。
  expect(await resolveHarnessConnection('claude', { connectionId: work.id })).toMatchObject({
    credentialHome: join(state.home, 'harness-connections', 'claude', work.id),
    configRootEnv: { CLAUDE_CONFIG_DIR: claudeVault(work.id) },
  });
  state.fixture!.sqlite.exec(`INSERT INTO sessions (id, project_id, provider, runtime, config)
    VALUES ('pinned', 'project', 'claude', 'acp', '{"version":"1","type":"acp","subscriptionConnectionId":"native"}');`);

  await selectHarnessConnection('claude', work.id);
  expect(await accessAt(state.claudeRoot)).toBe('work');
  expect(JSON.parse(await readFile(join(state.claudeRoot, '.credentials.json'), 'utf8'))).toMatchObject({ mcpOAuth: { docs: 'kept' } });
  expect(await accountAt(state.claudeRoot)).toBe('u-work');
  expect(JSON.parse(await readFile(join(state.claudeRoot, '.claude.json'), 'utf8'))).toMatchObject({ projects: { '/repo': { allowedTools: ['Bash'] } } });
  expect(await accessAt(claudeVault('native'))).toBe('original');
  for (const sessionId of ['pinned', undefined]) {
    const context = await resolveHarnessConnection('claude', sessionId ? { sessionId } : {});
    expect(context.connectionId).toBe(work.id);
    expect(context.configRootEnv).toBeUndefined();
    expect(context.credentialHome).toBeUndefined();
    expect(context.unsetEnv).toContain('ANTHROPIC_API_KEY');
  }
  expect(await sessionHarnessConnectionId('pinned')).toBe(work.id);
  expect((await resolveHarnessConnection('claude', { connectionId: work.id })).configRootEnv).toBeUndefined();

  // CLI 在用户根里轮换了 token:换走时这份新的要回到 Work 手里。
  await writeFile(join(state.claudeRoot, '.credentials.json'), claudeCredential('work-rotated', 300));
  await selectHarnessConnection('claude', 'native');
  expect(await accessAt(state.claudeRoot)).toBe('original');
  expect(await accountAt(state.claudeRoot)).toBe('u-original');
  expect(await accessAt(claudeVault(work.id))).toBe('work-rotated');
  expect(await sessionHarnessConnectionId('pinned')).toBe('native');
  expect(await sessionHarnessConnectionId('deleted')).toBeUndefined();
});

it('runs a Claude API connection on the user root through env only, leaving the signed-in account in place', async () => {
  await writeClaudeSignIn(state.claudeRoot, 'u-original', claudeCredential('original', 100));
  const api = await createHarnessConnection({ providerId: 'claude', kind: 'api-key', apiKey: 'fixture-key', endpoint: 'https://relay.example/v1' });
  await expect(stat(join(state.home, 'harness-connections', 'claude', api.id))).rejects.toThrow();
  await selectHarnessConnection('claude', api.id);
  const context = await resolveHarnessConnection('claude', { sessionId: 'old' });
  expect(context).toMatchObject({
    connectionId: api.id,
    credentialEnv: { ANTHROPIC_AUTH_TOKEN: 'fixture-key', ANTHROPIC_BASE_URL: 'https://relay.example/v1' },
  });
  expect(context.unsetEnv).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  expect(context.configRootEnv).toBeUndefined();
  expect(await accessAt(state.claudeRoot)).toBe('original');
  expect(JSON.stringify(await listHarnessConnections('claude'))).not.toContain('fixture-key');
});

it('refuses a Claude account with no saved sign-in and never falls back when a connection is missing', async () => {
  await writeClaudeSignIn(state.claudeRoot, 'u-original', claudeCredential('original', 100));
  const empty = await createHarnessConnection({ providerId: 'claude', kind: 'account' });
  await expect(selectHarnessConnection('claude', empty.id)).rejects.toThrow('no saved sign-in');
  expect(await accessAt(state.claudeRoot)).toBe('original');
  expect((await listHarnessConnections('claude')).find((row) => row.current)?.id).toBe('native');
  expect((await resolveHarnessConnection('codex')).connectionId).toBe('native');
  await expect(resolveHarnessConnection('claude', { connectionId: 'missing' })).rejects.toThrow('unavailable');
});

it('aligns Claude at startup: moves old connection history into the user root once, then puts the default account there', async () => {
  await writeClaudeSignIn(state.claudeRoot, 'u-original', claudeCredential('original', 100));
  const work = await createHarnessConnection({ providerId: 'claude', kind: 'account' });
  await writeClaudeSignIn(claudeVault(work.id), 'u-work', claudeCredential('work', 200));
  const project = (root: string) => join(root, 'projects', '-repo');
  await mkdir(project(claudeVault(work.id)), { recursive: true });
  await writeFile(join(project(claudeVault(work.id)), 'shared.jsonl'), 'connection copy');
  await writeFile(join(project(claudeVault(work.id)), 'only-there.jsonl'), 'ran on work');
  await mkdir(project(state.claudeRoot), { recursive: true });
  await writeFile(join(project(state.claudeRoot), 'shared.jsonl'), 'user copy');
  // 修复前的选择:只改了默认,凭据没进用户根。
  await state.fixture!.registry.setDefaultAccount('harness:claude', work.id);

  await alignClaudeConnections();
  expect(await readFile(join(project(state.claudeRoot), 'only-there.jsonl'), 'utf8')).toBe('ran on work');
  expect(await readFile(join(project(state.claudeRoot), 'shared.jsonl'), 'utf8')).toBe('user copy');
  expect(await accessAt(state.claudeRoot)).toBe('work');
  expect(await accessAt(claudeVault('native'))).toBe('original');

  // 第二次开机:不再搬(搬走后用户根里删掉的不会回来),账号已经在位也不再动。
  await rm(join(project(state.claudeRoot), 'only-there.jsonl'));
  await writeFile(join(state.claudeRoot, '.credentials.json'), claudeCredential('work-rotated', 300));
  await alignClaudeConnections();
  await expect(stat(join(project(state.claudeRoot), 'only-there.jsonl'))).rejects.toThrow();
  expect(await accessAt(state.claudeRoot)).toBe('work-rotated');
});

it('aligns Claude at startup when the native sign-in and the default account are the same account signed in twice', async () => {
  await writeClaudeSignIn(state.claudeRoot, 'u-same', claudeCredential('original', 100));
  const work = await createHarnessConnection({ providerId: 'claude', kind: 'account' });
  await writeClaudeSignIn(claudeVault(work.id), 'u-same', claudeCredential('work', 200));
  await state.fixture!.registry.setDefaultAccount('harness:claude', work.id);

  await alignClaudeConnections();
  expect(await accessAt(state.claudeRoot)).toBe('work');
  expect(await accessAt(claudeVault('native'))).toBe('original');
  // 原生那份存下来了:选得回去,换回来的是它自己的 token。
  await assertHarnessConnectionSelectable('claude', 'native');
  await writeFile(join(state.claudeRoot, '.credentials.json'), claudeCredential('work-rotated', 300));
  await selectHarnessConnection('claude', 'native');
  expect(await accessAt(state.claudeRoot)).toBe('original');
  expect(await accessAt(claudeVault(work.id))).toBe('work-rotated');
});

it('a Claude connection config root is where its old sessions ran (now its vault); native and Codex have none', async () => {
  const connection = await createHarnessConnection({ providerId: 'claude', kind: 'account' });
  const asked = await resolveHarnessConnection('claude', { connectionId: connection.id });
  expect(connectionConfigRoot('claude', connection.id)).toBe(asked.configRootEnv?.CLAUDE_CONFIG_DIR);
  expect(connectionConfigRoot('claude', 'native')).toBeNull();
  expect(connectionConfigRoot('codex', connection.id)).toBeNull();
});
