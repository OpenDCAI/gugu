import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activateClaudeAccount, claudeCredentialRoot, claudeLiveOwner, claudeSignInSaved, type ClaudeAuthSlotPaths } from './claude-auth-slot';
import { createClaudeCredentialStore, type ClaudeCredentialLocation, type ClaudeCredentialStore } from './claude-credential-store';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gugu-claude-slot-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function memoryStore() {
  const items = new Map<string, string>();
  const key = (location: ClaudeCredentialLocation) => `${location.root}|${location.suffixed}`;
  const store: ClaudeCredentialStore & { items: Map<string, string>; writes: string[] } = {
    items,
    writes: [],
    async read(location) {
      return items.get(key(location)) ?? null;
    },
    async write(location, text) {
      store.writes.push(key(location));
      items.set(key(location), text);
    },
  };
  return store;
}

function setup() {
  const store = memoryStore();
  const paths: ClaudeAuthSlotPaths = {
    nativeRoot: join(dir, 'home', '.claude'),
    nativeGlobalConfig: join(dir, 'home', '.claude.json'),
    nativeSuffixed: false,
    vaultRoot: (id) => join(dir, 'vault', id, '.claude'),
    backupDir: join(dir, 'backup'),
    liveStateFile: join(dir, 'state', 'claude-live.json'),
    store,
    lockRetries: 0,
  };
  return { paths, store };
}

/** 按 CLI 的方式拿一把锁(同样的 lockfilePath),模拟它正在刷新 / 正在写 `.claude.json`。 */
async function holdLikeClaude(target: string, lockfilePath: string, stale = 10_000) {
  await mkdir(join(lockfilePath, '..'), { recursive: true });
  return lockfile.lock(target, { realpath: false, lockfilePath, stale, update: stale / 2 });
}

/** 一次切换之后,它拿过的锁目录一个都不许留下(留下的会挡住下一次切换,也挡住 CLI 刷新)。 */
async function leftoverLocks(ctx: ReturnType<typeof setup>) {
  const { readdir: list } = await import('node:fs/promises');
  const under = async (path: string) => (await list(path).catch(() => [] as string[])).filter((name) => name.endsWith('.lock'));
  const vaults = (await list(join(dir, 'vault')).catch(() => [] as string[])).map((id) => ctx.paths.vaultRoot(id));
  return [
    ...(await under(join(dir, 'home'))),
    ...(await under(ctx.paths.nativeRoot)),
    ...(await Promise.all(vaults.flatMap((root) => [under(root), under(join(root, '..'))]))).flat(),
  ];
}

type Json = Record<string, unknown>;
const credential = (access: string, expiresAt: number, extra: Json = {}) =>
  JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: `r-${access}`, expiresAt }, ...extra });
const accessOf = (text: string | undefined) => (JSON.parse(text ?? '{}') as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken;

async function writeConfig(path: string, uuid: string, extra: Json = {}) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@example.com` }, hasCompletedOnboarding: true, ...extra }));
}
const readConfig = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Json;
const accountUuid = (config: Json) => (config.oauthAccount as { accountUuid?: string }).accountUuid;

async function seedVault(ctx: ReturnType<typeof setup>, id: string, uuid: string, access: string, expiresAt: number) {
  ctx.store.items.set(`${ctx.paths.vaultRoot(id)}|true`, credential(access, expiresAt));
  await writeConfig(join(ctx.paths.vaultRoot(id), '.claude.json'), uuid);
}
async function seedLive(ctx: ReturnType<typeof setup>, uuid: string, access: string, expiresAt: number, credentialExtra: Json = {}, configExtra: Json = {}) {
  ctx.store.items.set(`${ctx.paths.nativeRoot}|false`, credential(access, expiresAt, credentialExtra));
  await writeConfig(ctx.paths.nativeGlobalConfig, uuid, configExtra);
}
const vaultText = (ctx: ReturnType<typeof setup>, id: string) => ctx.store.items.get(`${ctx.paths.vaultRoot(id)}|true`);
const liveText = (ctx: ReturnType<typeof setup>) => ctx.store.items.get(`${ctx.paths.nativeRoot}|false`);

describe('activateClaudeAccount', () => {
  it('saves the rotated live token back to its owner, installs the target, and leaves everything else in place', async () => {
    const ctx = setup();
    await seedVault(ctx, 'A', 'uuid-a', 'a-old', 100);
    await seedVault(ctx, 'B', 'uuid-b', 'b-token', 300);
    await seedLive(ctx, 'uuid-a', 'a-rotated', 200, { mcpOAuth: { server: 'kept' } }, { projects: { '/x': 1 }, theme: 'dark' });

    const owner = await activateClaudeAccount(ctx.paths, ['native', 'A', 'B'], 'B', 'A');

    expect(owner).toBe('A');
    expect(accessOf(vaultText(ctx, 'A'))).toBe('a-rotated');
    expect(accessOf(liveText(ctx))).toBe('b-token');
    // 别的键(MCP 登录)留在用户根里,没被整段凭据互换带走。
    expect(JSON.parse(liveText(ctx)!)).toMatchObject({ mcpOAuth: { server: 'kept' } });
    expect(JSON.parse(vaultText(ctx, 'A')!)).not.toHaveProperty('mcpOAuth');
    const config = await readConfig(ctx.paths.nativeGlobalConfig);
    expect(accountUuid(config)).toBe('uuid-b');
    expect(config).toMatchObject({ projects: { '/x': 1 }, theme: 'dark', hasCompletedOnboarding: true });
    expect(accountUuid(await readConfig(join(ctx.paths.vaultRoot('A'), '.claude.json')))).toBe('uuid-a');
  });

  it('round-trips: switching away and back returns the token the CLI rotated in between', async () => {
    const ctx = setup();
    await seedVault(ctx, 'A', 'uuid-a', 'a-old', 100);
    await seedVault(ctx, 'B', 'uuid-b', 'b-old', 100);
    await seedLive(ctx, 'uuid-a', 'a-rotated', 200);
    await activateClaudeAccount(ctx.paths, ['native', 'A', 'B'], 'B', 'A');
    ctx.store.items.set(`${ctx.paths.nativeRoot}|false`, credential('b-rotated', 400));

    await activateClaudeAccount(ctx.paths, ['native', 'A', 'B'], 'A', 'B');

    expect(accessOf(liveText(ctx))).toBe('a-rotated');
    expect(accessOf(vaultText(ctx, 'B'))).toBe('b-rotated');
    expect(accountUuid(await readConfig(ctx.paths.nativeGlobalConfig))).toBe('uuid-a');
    expect(await leftoverLocks(ctx)).toEqual([]);
  });

  it('does not overwrite a fresher saved token with an older one from the live root', async () => {
    const ctx = setup();
    await seedVault(ctx, 'A', 'uuid-a', 'a-fresh', 500);
    await seedVault(ctx, 'B', 'uuid-b', 'b-token', 300);
    await seedLive(ctx, 'uuid-a', 'a-stale', 100);

    await activateClaudeAccount(ctx.paths, ['native', 'A', 'B'], 'B', 'A');

    expect(accessOf(vaultText(ctx, 'A'))).toBe('a-fresh');
    expect(accessOf(liveText(ctx))).toBe('b-token');
  });

  it('files the first account under its own connection when native never had a sign-in', async () => {
    const ctx = setup();
    await seedVault(ctx, 'A', 'uuid-a', 'a-old', 100);
    await seedVault(ctx, 'B', 'uuid-b', 'b-token', 300);
    await seedLive(ctx, 'uuid-a', 'a-rotated', 200);

    expect(await claudeLiveOwner(ctx.paths, ['native', 'A', 'B'], 'A')).toBe('A');
    await activateClaudeAccount(ctx.paths, ['native', 'A', 'B'], 'B', 'A');

    expect(accessOf(vaultText(ctx, 'A'))).toBe('a-rotated');
    expect(ctx.store.items.has(`${ctx.paths.vaultRoot('native')}|true`)).toBe(false);
  });

  it('keeps a copy of an account nobody recognizes instead of overwriting it', async () => {
    const ctx = setup();
    await seedVault(ctx, 'native', 'uuid-n', 'n-saved', 100);
    await seedVault(ctx, 'A', 'uuid-a', 'a-token', 300);
    await seedLive(ctx, 'uuid-z', 'z-token', 200);

    const owner = await activateClaudeAccount(ctx.paths, ['native', 'A'], 'A', 'native', () => new Date('2026-10-23T01:02:03.004Z'));

    expect(owner).toBeNull();
    const backups = await readdir(ctx.paths.backupDir);
    expect(backups).toEqual(['credentials-2026-10-23T01-02-03-004Z.json']);
    expect(await readFile(join(ctx.paths.backupDir, backups[0]!), 'utf8')).toContain('z-token');
    expect(accessOf(vaultText(ctx, 'native'))).toBe('n-saved');
    expect(accessOf(liveText(ctx))).toBe('a-token');
  });

  it('puts the credential back when the account info cannot be written (Claude is writing .claude.json)', async () => {
    const ctx = setup();
    await seedVault(ctx, 'A', 'uuid-a', 'a-old', 100);
    await seedVault(ctx, 'B', 'uuid-b', 'b-token', 300);
    await seedLive(ctx, 'uuid-a', 'a-rotated', 200);
    const before = liveText(ctx);
    const release = await holdLikeClaude(ctx.paths.nativeGlobalConfig, `${ctx.paths.nativeGlobalConfig}.lock`);
    try {
      await expect(activateClaudeAccount(ctx.paths, ['native', 'A', 'B'], 'B', 'A')).rejects.toThrow('try switching again');
    } finally {
      await release();
    }

    expect(liveText(ctx)).toBe(before);
    expect(accountUuid(await readConfig(ctx.paths.nativeGlobalConfig))).toBe('uuid-a');
  });

  it('does not touch anything while Claude holds either refresh lock of the user root, and switches once it lets go', async () => {
    const ctx = setup();
    await seedVault(ctx, 'A', 'uuid-a', 'a-old', 100);
    await seedVault(ctx, 'B', 'uuid-b', 'b-token', 300);
    await seedLive(ctx, 'uuid-a', 'a-rotated', 200);
    await mkdir(ctx.paths.nativeRoot, { recursive: true });
    const legacy = `${await realpath(ctx.paths.nativeRoot)}.lock`;
    for (const lockfilePath of [join(ctx.paths.nativeRoot, '.oauth_refresh.lock'), legacy, join(ctx.paths.nativeRoot, '.storage-write.lock')]) {
      const release = await holdLikeClaude(ctx.paths.nativeRoot, lockfilePath, 60_000);
      try {
        await expect(activateClaudeAccount(ctx.paths, ['native', 'A', 'B'], 'B', 'A')).rejects.toThrow('try switching again');
      } finally {
        await release();
      }
      expect(ctx.store.writes).toEqual([]);
    }

    expect(await activateClaudeAccount(ctx.paths, ['native', 'A', 'B'], 'B', 'A')).toBe('A');
    expect(accessOf(liveText(ctx))).toBe('b-token');
  });

  it('remembers who it put in the live root, so a detour through an API connection does not misfile the token', async () => {
    const ctx = setup();
    await seedVault(ctx, 'A', 'uuid-a', 'a-old', 100);
    await seedVault(ctx, 'B', 'uuid-b', 'b-token', 300);
    // 新用户:原生从没登录过。选中 A。
    await activateClaudeAccount(ctx.paths, ['native', 'A', 'B'], 'A', 'native');
    ctx.store.items.set(`${ctx.paths.nativeRoot}|false`, credential('a-rotated', 200));
    // 期间选过 API 连接 K(不进 connectionIds,也不动用户根),现在从 K 切回 A、再切到 B。
    expect(await activateClaudeAccount(ctx.paths, ['native', 'A', 'B'], 'A', 'K')).toBe('A');
    expect(accessOf(liveText(ctx))).toBe('a-rotated');
    expect(await activateClaudeAccount(ctx.paths, ['native', 'A', 'B'], 'B', 'K')).toBe('A');
    expect(accessOf(vaultText(ctx, 'A'))).toBe('a-rotated');
    expect(ctx.store.items.has(`${ctx.paths.vaultRoot('native')}|true`)).toBe(false);
  });

  it('puts the original credential back when writing the new one into the live root fails part-way', async () => {
    const ctx = setup();
    await seedVault(ctx, 'A', 'uuid-a', 'a-old', 100);
    await seedVault(ctx, 'B', 'uuid-b', 'b-token', 300);
    await seedLive(ctx, 'uuid-a', 'a-rotated', 200, { mcpOAuth: { docs: 'kept' } });
    const before = liveText(ctx);
    const write = ctx.store.write;
    let failed = false;
    ctx.store.write = async (location, text) => {
      if (!failed && location.root === ctx.paths.nativeRoot) {
        failed = true;
        ctx.store.items.set(`${location.root}|${location.suffixed}`, text.slice(0, 20)); // 写了半份
        throw new Error('The Claude sign-in was not stored intact in the keychain');
      }
      return write(location, text);
    };

    await expect(activateClaudeAccount(ctx.paths, ['native', 'A', 'B'], 'B', 'A')).rejects.toThrow('not stored intact');

    expect(liveText(ctx)).toBe(before);
    expect(accountUuid(await readConfig(ctx.paths.nativeGlobalConfig))).toBe('uuid-a');
  });

  it('keeps a symlinked .claude.json a symlink', async () => {
    const ctx = setup();
    await seedVault(ctx, 'A', 'uuid-a', 'a-old', 100);
    await seedVault(ctx, 'B', 'uuid-b', 'b-token', 300);
    const real = join(dir, 'dotfiles', 'claude.json');
    await writeConfig(real, 'uuid-a', { theme: 'dark' });
    await mkdir(join(dir, 'home'), { recursive: true });
    await symlink(real, ctx.paths.nativeGlobalConfig);
    ctx.store.items.set(`${ctx.paths.nativeRoot}|false`, credential('a-rotated', 200));

    await activateClaudeAccount(ctx.paths, ['native', 'A', 'B'], 'B', 'A');

    expect((await lstat(ctx.paths.nativeGlobalConfig)).isSymbolicLink()).toBe(true);
    expect(await readConfig(real)).toMatchObject({ theme: 'dark', oauthAccount: { accountUuid: 'uuid-b' } });
  });

  it('tells whether a connection has a sign-in that can be switched in', async () => {
    const ctx = setup();
    await seedVault(ctx, 'A', 'uuid-a', 'a-old', 100);
    expect(await claudeSignInSaved(ctx.paths, 'A')).toBe(true);
    expect(await claudeSignInSaved(ctx.paths, 'C')).toBe(false);
  });

  it('refuses a target with no saved sign-in without touching the live root', async () => {
    const ctx = setup();
    await seedVault(ctx, 'A', 'uuid-a', 'a-old', 100);
    await seedLive(ctx, 'uuid-a', 'a-rotated', 200);
    const before = liveText(ctx);

    await expect(activateClaudeAccount(ctx.paths, ['native', 'A', 'C'], 'C', 'A')).rejects.toThrow('no saved sign-in');

    expect(liveText(ctx)).toBe(before);
    expect(accessOf(vaultText(ctx, 'A'))).toBe('a-old');
    expect(ctx.store.writes).toEqual([]);
  });

  it('does nothing when the target already owns the live root', async () => {
    const ctx = setup();
    await seedVault(ctx, 'A', 'uuid-a', 'a-old', 100);
    await seedLive(ctx, 'uuid-a', 'a-rotated', 200);

    expect(await activateClaudeAccount(ctx.paths, ['native', 'A'], 'A', 'A')).toBe('A');
    expect(ctx.store.writes).toEqual([]);
  });
});

describe.runIf(process.platform === 'darwin')('activateClaudeAccount against a real temporary keychain', () => {
  let keychain = '';
  beforeEach(() => {
    keychain = join(dir, 'test.keychain-db');
    execFileSync('/usr/bin/security', ['create-keychain', '-p', 'pw', keychain]);
    execFileSync('/usr/bin/security', ['unlock-keychain', '-p', 'pw', keychain]);
  });
  afterEach(() => {
    execFileSync('/usr/bin/security', ['delete-keychain', keychain]);
  });

  it('moves sign-ins between the default item and the per-vault items and back', async () => {
    const store = createClaudeCredentialStore({ platform: 'darwin', account: 'gugu-test', keychain });
    const paths: ClaudeAuthSlotPaths = {
      nativeRoot: join(dir, 'home', '.claude'),
      nativeGlobalConfig: join(dir, 'home', '.claude.json'),
      nativeSuffixed: false,
      vaultRoot: (id) => join(dir, 'vault', id, '.claude'),
      backupDir: join(dir, 'backup'),
      liveStateFile: join(dir, 'state', 'claude-live.json'),
      store,
      lockRetries: 0,
    };
    const native = { root: paths.nativeRoot, suffixed: false };
    const vaultOf = (id: string) => ({ root: paths.vaultRoot(id), suffixed: true });
    await store.write(native, credential('a-live', 200, { mcpOAuth: { docs: 'kept' } }));
    await writeConfig(paths.nativeGlobalConfig, 'uuid-a');
    await store.write(vaultOf('A'), credential('a-old', 100));
    await writeConfig(join(paths.vaultRoot('A'), '.claude.json'), 'uuid-a');
    await store.write(vaultOf('B'), credential('b-token', 300));
    await writeConfig(join(paths.vaultRoot('B'), '.claude.json'), 'uuid-b');

    await activateClaudeAccount(paths, ['native', 'A', 'B'], 'B', 'A');
    expect(accessOf((await store.read(native))!)).toBe('b-token');
    expect(JSON.parse((await store.read(native))!)).toMatchObject({ mcpOAuth: { docs: 'kept' } });
    expect(accessOf((await store.read(vaultOf('A')))!)).toBe('a-live');

    await activateClaudeAccount(paths, ['native', 'A', 'B'], 'A', 'B');
    expect(accessOf((await store.read(native))!)).toBe('a-live');
    expect(accessOf((await store.read(vaultOf('B')))!)).toBe('b-token');
    // 凭据只在钥匙串里,❌ 落一份明文文件。
    await expect(readFile(join(paths.nativeRoot, '.credentials.json'), 'utf8')).rejects.toThrow();
  });
});

describe('claudeLiveOwner / claudeCredentialRoot', () => {
  it('trusts the selected connection when the live account matches it', async () => {
    const ctx = setup();
    await seedVault(ctx, 'A', 'uuid-a', 'a', 100);
    await seedLive(ctx, 'uuid-a', 'a-live', 200);
    expect(await claudeLiveOwner(ctx.paths, ['native', 'A'], 'A')).toBe('A');
    expect(await claudeCredentialRoot(ctx.paths, ['native', 'A'], 'A', 'A')).toBe('native');
    expect(await claudeCredentialRoot(ctx.paths, ['native', 'A', 'B'], 'B', 'A')).toBe('vault');
  });

  it('treats the live root as native until native has been switched out once', async () => {
    const ctx = setup();
    await seedLive(ctx, 'uuid-n', 'n-live', 200);
    expect(await claudeLiveOwner(ctx.paths, ['native', 'A'], 'native')).toBe('native');
  });

  it('finds the owner by account identity after the user signed in from a terminal', async () => {
    const ctx = setup();
    await seedVault(ctx, 'native', 'uuid-n', 'n', 100);
    await seedVault(ctx, 'A', 'uuid-a', 'a', 100);
    await seedLive(ctx, 'uuid-a', 'a-live', 200);
    expect(await claudeLiveOwner(ctx.paths, ['native', 'A'], 'native')).toBe('A');
  });

  it('reports no owner for an unknown account once native has a saved one', async () => {
    const ctx = setup();
    await seedVault(ctx, 'native', 'uuid-n', 'n', 100);
    await seedLive(ctx, 'uuid-z', 'z-live', 200);
    expect(await claudeLiveOwner(ctx.paths, ['native', 'A'], 'native')).toBeNull();
  });
});
