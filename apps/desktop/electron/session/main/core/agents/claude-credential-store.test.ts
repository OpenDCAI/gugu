import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeKeychainService, createClaudeCredentialStore, type SecurityRunner } from './claude-credential-store';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gugu-claude-cred-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SECRET = '{"claudeAiOauth":{"accessToken":"a-token","refreshToken":"r-token"}}';

describe('claudeKeychainService', () => {
  it('uses the bare service for the default root and a path-hash suffix for any other root', () => {
    expect(claudeKeychainService({ root: '/home/user/.claude', suffixed: false })).toBe('Claude Code-credentials');
    // sha256('/home/user/.config/claude-work').slice(0, 8)
    expect(claudeKeychainService({ root: '/home/user/.config/claude-work', suffixed: true })).toBe('Claude Code-credentials-e9e628e4');
  });
});

describe('file store (platforms without a keychain)', () => {
  it('reads null when absent and round-trips the whole text through .credentials.json with 0600', async () => {
    const store = createClaudeCredentialStore({ platform: 'linux' });
    const location = { root: join(dir, 'root'), suffixed: false };
    expect(await store.read(location)).toBeNull();
    await store.write(location, SECRET);
    expect(await store.read(location)).toBe(SECRET);
    expect((await stat(join(location.root, '.credentials.json'))).mode & 0o777).toBe(0o600);
  });
});

describe('macOS store with a scripted security runner', () => {
  function fake(items: Map<string, string>, calls: { find: string[][]; written: string[] }): SecurityRunner {
    return {
      async find(args) {
        calls.find.push(args);
        const service = args[args.indexOf('-s') + 1]!;
        return items.has(service) ? `${items.get(service)}\n` : null;
      },
      async interactive(command) {
        calls.written.push(command);
        const service = /-s "([^"]+)"/.exec(command)![1]!;
        const hex = /-X ([0-9a-f]+)/.exec(command)![1]!;
        items.set(service, Buffer.from(hex, 'hex').toString('utf8'));
      },
    };
  }

  it('reads through find-generic-password -w and writes the secret over stdin as hex, never in argv', async () => {
    const items = new Map<string, string>();
    const calls = { find: [] as string[][], written: [] as string[] };
    const store = createClaudeCredentialStore({ platform: 'darwin', account: 'someone', security: fake(items, calls) });
    const location = { root: join(dir, 'root'), suffixed: true };
    await store.write(location, SECRET);
    expect(calls.written).toHaveLength(1);
    expect(calls.written[0]).toContain('add-generic-password -U -a "someone" -s "Claude Code-credentials-');
    expect(calls.written[0]).not.toContain('a-token');
    expect(await store.read(location)).toBe(SECRET);
    expect(calls.find.every((args) => !args.join(' ').includes('a-token'))).toBe(true);
  });

  it('decodes a hex-encoded secret that security prints for non-printable data', async () => {
    const hex = Buffer.from(SECRET, 'utf8').toString('hex');
    const store = createClaudeCredentialStore({
      platform: 'darwin',
      security: { find: async () => `${hex}\n`, interactive: async () => undefined },
    });
    expect(await store.read({ root: dir, suffixed: false })).toBe(SECRET);
  });

  it('falls back to .credentials.json when the keychain has no item, and writes there while that is where the CLI keeps it', async () => {
    const items = new Map<string, string>();
    const calls = { find: [] as string[][], written: [] as string[] };
    const store = createClaudeCredentialStore({ platform: 'darwin', security: fake(items, calls) });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.credentials.json'), '{"old":true}');
    expect(await store.read({ root: dir, suffixed: false })).toBe('{"old":true}');
    await store.write({ root: dir, suffixed: false }, SECRET);
    expect(await readFile(join(dir, '.credentials.json'), 'utf8')).toBe(SECRET);
    expect(calls.written).toHaveLength(0);
  });

  it('does not treat a failing keychain as "no credential"', async () => {
    const store = createClaudeCredentialStore({
      platform: 'darwin',
      security: { find: async () => { throw new Error('keychain locked'); }, interactive: async () => undefined },
    });
    await expect(store.read({ root: dir, suffixed: false })).rejects.toThrow('keychain locked');
  });
});

describe.runIf(process.platform === 'darwin')('macOS store against a real temporary keychain', () => {
  let keychain = '';
  beforeEach(() => {
    keychain = join(dir, 'test.keychain-db');
    execFileSync('/usr/bin/security', ['create-keychain', '-p', 'pw', keychain]);
    execFileSync('/usr/bin/security', ['unlock-keychain', '-p', 'pw', keychain]);
  });
  afterEach(() => {
    execFileSync('/usr/bin/security', ['delete-keychain', keychain]);
  });

  it('round-trips, overwrites in place, and keeps roots apart', async () => {
    const store = createClaudeCredentialStore({ platform: 'darwin', account: 'gugu-test', keychain });
    const a = { root: join(dir, 'a'), suffixed: true };
    const b = { root: join(dir, 'b'), suffixed: true };
    expect(await store.read(a)).toBeNull();
    await store.write(a, SECRET);
    await store.write(b, '{"other":1}');
    expect(await store.read(a)).toBe(SECRET);
    expect(await store.read(b)).toBe('{"other":1}');
    await store.write(a, '{"rotated":true}');
    expect(await store.read(a)).toBe('{"rotated":true}');
    expect(await store.read(b)).toBe('{"other":1}');
  });
});
