import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { forkAntigravityCliSession, forkAntigravitySession } from './fork';

const OLD = '9c587baf-c3d7-46e6-98d8-dca6d61422ef';
const NEW = 'e523d858-c162-4255-ac99-c44eea279415';

function seedStore(store: 'antigravity-acp' | 'antigravity-cli' = 'antigravity-acp'): { home: string; dir: string } {
  const home = mkdtempSync(join(tmpdir(), 'agy-fork-'));
  const dir = join(home, store, 'conversations');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, `${OLD}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  // 与 1.2.1 实测的库同形:id 在 TEXT 列里,也在 protobuf blob 里(前面带长度前缀 0x24 = 36)。
  db.exec('CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text, PRIMARY KEY (trajectory_id))');
  db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_payload blob)');
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run(OLD, OLD);
  const blob = Buffer.concat([Buffer.from([0x0a, 0x24]), Buffer.from(OLD), Buffer.from('hello PROBE-FIRST')]);
  db.prepare('INSERT INTO steps VALUES (?, ?)').run(0, blob);
  db.close();
  writeFileSync(join(dir, `${OLD}.meta`), JSON.stringify({ cwd: '/ws', mode_id: 'yolo' }));
  return { home, dir };
}

describe('forkAntigravitySession(#6335)', () => {
  it('复制一份新 id 的存档,库里每一处旧 id 等长换成新 id,来源不动', async () => {
    const { home, dir } = seedStore();
    const result = await forkAntigravitySession(
      { sourceProviderSessionId: OLD, cwd: '/ws', env: { GEMINI_HOME: home }, homeDir: '/nowhere' },
      NEW
    );
    expect(result).toEqual({ providerSessionId: NEW });

    const forked = new DatabaseSync(join(dir, `${NEW}.db`), { readOnly: true });
    expect(forked.prepare('SELECT * FROM trajectory_meta').all()).toEqual([
      { trajectory_id: NEW, cascade_id: NEW },
    ]);
    const payload = Buffer.from((forked.prepare('SELECT step_payload FROM steps').get() as { step_payload: Uint8Array }).step_payload);
    forked.close();
    expect(payload.includes(Buffer.from(NEW))).toBe(true);
    expect(payload.includes(Buffer.from(OLD))).toBe(false);
    expect(payload[1]).toBe(0x24);
    expect(payload.includes(Buffer.from('hello PROBE-FIRST'))).toBe(true);

    const source = new DatabaseSync(join(dir, `${OLD}.db`), { readOnly: true });
    expect(source.prepare('SELECT cascade_id FROM trajectory_meta').get()).toEqual({ cascade_id: OLD });
    source.close();
    expect(JSON.parse(readFileSync(join(dir, `${NEW}.meta`), 'utf8'))).toEqual({ cwd: '/ws', mode_id: 'yolo' });
  });

  it('来源不存在 / id 形状不对 ⇒ 响亮失败,❌ 不留半份', async () => {
    const { home, dir } = seedStore();
    const ctx = { cwd: '/ws', env: { GEMINI_HOME: home }, homeDir: '/nowhere' };
    await expect(
      forkAntigravitySession({ ...ctx, sourceProviderSessionId: '11111111-2222-3333-4444-555555555555' }, NEW)
    ).rejects.toThrow(/no stored session/);
    await expect(forkAntigravitySession({ ...ctx, sourceProviderSessionId: 'not-a-uuid' }, NEW)).rejects.toThrow(/shape/);
    expect(existsSync(join(dir, `${NEW}.db`))).toBe(false);
  });

  it('没有 GEMINI_HOME 时落回 ~/.gemini', async () => {
    const { home } = seedStore();
    const osHome = join(home, 'os');
    mkdirSync(join(osHome, '.gemini'), { recursive: true });
    await expect(
      forkAntigravitySession({ sourceProviderSessionId: OLD, cwd: '/ws', env: {}, homeDir: osHome }, NEW)
    ).rejects.toThrow(join(osHome, '.gemini', 'antigravity-acp', 'conversations'));
  });

  it('终端腿:同一个做法落在 antigravity-cli/conversations,聊天面板腿那份一个字节不碰', async () => {
    const { home, dir } = seedStore('antigravity-cli');
    await expect(
      forkAntigravityCliSession({ sourceProviderSessionId: OLD, cwd: '/ws', env: { GEMINI_HOME: home }, homeDir: '/nowhere' }, NEW)
    ).resolves.toEqual({ providerSessionId: NEW });
    const forked = new DatabaseSync(join(dir, `${NEW}.db`), { readOnly: true });
    expect(forked.prepare('SELECT cascade_id FROM trajectory_meta').get()).toEqual({ cascade_id: NEW });
    forked.close();
    const source = new DatabaseSync(join(dir, `${OLD}.db`), { readOnly: true });
    expect(source.prepare('SELECT cascade_id FROM trajectory_meta').get()).toEqual({ cascade_id: OLD });
    source.close();
    expect(existsSync(join(home, 'antigravity-acp'))).toBe(false);
  });
});
