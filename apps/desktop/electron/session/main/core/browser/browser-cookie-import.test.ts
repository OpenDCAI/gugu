import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_ISOLATED_PROFILE_ID, browserProfilePartition } from '@shared/browser';

/**
 * #7191「从默认浏览器导入登录」整条走一遍:默认浏览器 → sweet-cookie 真读 → 换形状 → 写进那份配置。
 * 用 Firefox 造数据(值不加密,读的时候不碰钥匙串,测试里不会弹系统授权框);假的只有 Electron 那两样
 * (默认浏览器是谁、配置的 cookie 存储)。HOME 指到临时目录,❌ 碰这台机器上真的浏览器。
 */

const electron = vi.hoisted(() => ({ defaultBrowserName: 'Firefox' }));
const store = vi.hoisted(() => ({
  partitions: [] as string[],
  set: [] as Array<Record<string, unknown>>,
  flushed: 0,
  rejectNames: new Set<string>(),
}));

vi.mock('electron', () => ({ app: { getApplicationNameForProtocol: () => electron.defaultBrowserName } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./browser-profile-session', () => ({
  configureBrowserProfileSession: (partition: string) => {
    store.partitions.push(partition);
    return {
      cookies: {
        set: async (details: Record<string, unknown>) => {
          if (store.rejectNames.has(String(details.name))) throw new Error('rejected by Chromium');
          store.set.push(details);
        },
        flushStore: async () => {
          store.flushed += 1;
        },
      },
    };
  },
}));

import { importDefaultBrowserCookies } from './browser-cookie-import';

type Row = { name: string; value: string; host: string; sameSite?: number; secure?: 0 | 1 };

let home: string;
const realHome = process.env.HOME;

function firefoxProfileWith(rows: Row[]) {
  const dir = join(home, 'Library', 'Application Support', 'Firefox', 'Profiles', 'abc.default-release');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'cookies.sqlite'));
  db.exec(`CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT,
    host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER,
    inBrowserElement INTEGER DEFAULT 0, sameSite INTEGER DEFAULT 0, rawSameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0)`);
  const insert = db.prepare('INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, 1, ?)');
  for (const row of rows) insert.run(row.name, row.value, row.host, '/', 4_000_000_000, row.secure ?? 1, row.sameSite ?? 1);
  db.close();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gugu-cookie-home-'));
  process.env.HOME = home;
  electron.defaultBrowserName = 'Firefox';
  store.partitions = [];
  store.set = [];
  store.flushed = 0;
  store.rejectNames = new Set();
});

afterEach(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe.runIf(process.platform === 'darwin')('#7191 从默认浏览器导入登录(整条)', () => {
  it('全部站点的 cookie 一次导进选中的那份配置,报导了多少、跳过多少', async () => {
    firefoxProfileWith([
      { name: 'sid', value: 'a', host: '.example.com' },
      { name: 'host_only', value: 'b', host: 'app.example.org' },
      { name: 'cross', value: 'c', host: '.third.test', sameSite: 0 },
      { name: 'refused', value: 'd', host: '.refuse.test' },
    ]);
    store.rejectNames.add('refused');

    const result = await importDefaultBrowserCookies('work');

    expect(result).toEqual({ ok: true, browser: 'Firefox', imported: 3, skipped: 1, partial: null });
    expect(store.partitions).toEqual([browserProfilePartition('work')]);
    expect(store.flushed).toBe(1);
    const byName = Object.fromEntries(store.set.map((c) => [c.name, c]));
    expect(byName.sid).toMatchObject({ url: 'https://example.com/', domain: 'example.com', value: 'a' });
    expect(byName.host_only).not.toHaveProperty('domain');
    expect(byName.cross).toMatchObject({ sameSite: 'no_restriction', secure: true });
  });

  it('认不出的默认浏览器:不读、不写,说清是不支持', async () => {
    electron.defaultBrowserName = 'Orion';
    expect(await importDefaultBrowserCookies('work')).toEqual({ ok: false, browser: 'Orion', reason: 'unsupported-browser' });
    expect(store.partitions).toEqual([]);
  });

  it('一条也没读到 = 失败(❌ 报成「成功导入 0 条」)', async () => {
    const result = await importDefaultBrowserCookies('work');
    expect(result.ok).toBe(false);
    expect(store.partitions).toEqual([]);
  });

  it('「每个任务独立」不是一份能导进去的配置', async () => {
    await expect(importDefaultBrowserCookies(BROWSER_ISOLATED_PROFILE_ID)).rejects.toThrow(/not a browser profile/);
  });
});
