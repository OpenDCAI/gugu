import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getCookies } from '@steipete/sweet-cookie';
import { describe, expect, it } from 'vitest';
import {
  chromiumProfileOption,
  chromiumUserDataRoot,
  classifyCookieReadFailure,
  cookieSourceForBrowserName,
  lastUsedChromiumProfile,
  partialReadFailure,
  toElectronCookie,
} from './browser-cookie-mapping';

describe('#7191 认出默认浏览器是哪一家', () => {
  it.each([
    ['Google Chrome', { backend: 'chrome', chromium: 'chrome' }],
    ['Microsoft Edge', { backend: 'edge' }],
    ['Brave Browser', { backend: 'chrome', chromium: 'brave' }],
    ['Arc', { backend: 'chrome', chromium: 'arc' }],
    ['Firefox', { backend: 'firefox' }],
    ['Safari', { backend: 'safari' }],
    ['Chromium', { backend: 'chrome', chromium: 'chromium' }],
  ])('%s', (name, source) => {
    expect(cookieSourceForBrowserName(name)).toEqual(source);
  });

  it('认不出的不猜', () => {
    expect(cookieSourceForBrowserName('Orion')).toBeNull();
    expect(cookieSourceForBrowserName('')).toBeNull();
  });

  it('读哪个 Chromium 配置:Windows 上一律给完整路径,认不出目录的不读(❌ 把 Chrome 的登录当成它的)', () => {
    const brave = { backend: 'chrome', chromium: 'brave' } as const;
    expect(chromiumProfileOption(brave, 'darwin', '/r', 'Profile 1')).toEqual({ chromeProfile: 'Profile 1' });
    expect(chromiumProfileOption(brave, 'win32', 'C:\\L\\Brave\\User Data', 'Profile 1')).toEqual({
      chromeProfile: 'C:\\L\\Brave\\User Data\\Profile 1',
    });
    expect(chromiumProfileOption({ backend: 'chrome', chromium: 'chrome' }, 'win32', 'C:\\G', null)).toEqual({ chromeProfile: 'C:\\G\\Default' });
    expect(chromiumProfileOption({ backend: 'chrome', chromium: 'arc' }, 'win32', null, null)).toBeNull();
    expect(chromiumProfileOption({ backend: 'edge' }, 'win32', 'C:\\E', 'Profile 2')).toEqual({ edgeProfile: 'Profile 2' });
    expect(chromiumProfileOption({ backend: 'firefox' }, 'win32', null, null)).toEqual({});
  });

  it('Chrome 的用户数据根目录与最近用的配置', () => {
    expect(chromiumUserDataRoot({ backend: 'chrome', chromium: 'chrome' }, 'darwin', { home: '/Users/me' })).toBe(
      '/Users/me/Library/Application Support/Google/Chrome',
    );
    expect(chromiumUserDataRoot({ backend: 'edge' }, 'win32', { home: 'C:\\Users\\me', localAppData: 'C:\\L' })).toBe(
      'C:\\L\\Microsoft\\Edge\\User Data',
    );
    expect(lastUsedChromiumProfile('{"profile":{"last_used":"Profile 2"}}')).toBe('Profile 2');
    expect(lastUsedChromiumProfile('not json')).toBeNull();
  });
});

describe('#7191 读到的 cookie → session.cookies.set', () => {
  it('整个域的 cookie 带 domain;只认一个主机的不带(否则会变成整个域都发)', () => {
    expect(toElectronCookie({ name: 'sid', value: 'v', domain: '.example.com', path: '/', secure: true, sameSite: 'Lax' })).toMatchObject({
      url: 'https://example.com/',
      domain: 'example.com',
      sameSite: 'lax',
      secure: true,
    });
    const hostOnly = toElectronCookie({ name: 'h', value: 'v', domain: 'a.example.com', hostOnly: true });
    expect(hostOnly).not.toHaveProperty('domain');
    expect(hostOnly?.url).toBe('http://a.example.com/');
  });

  it('SameSite=None 与 __Secure- / __Host- 只能落在 https 上', () => {
    expect(toElectronCookie({ name: 'x', value: 'v', domain: 'a.com', sameSite: 'None' })).toMatchObject({ secure: true, sameSite: 'no_restriction' });
    expect(toElectronCookie({ name: '__Host-x', value: 'v', domain: 'a.com', hostOnly: true })?.url).toMatch(/^https:/);
  });

  it('没有过期时间 = 会话 cookie;没有域名的放不进去,算跳过', () => {
    expect(toElectronCookie({ name: 's', value: 'v', domain: 'a.com' })).not.toHaveProperty('expirationDate');
    expect(toElectronCookie({ name: 's', value: 'v', domain: 'a.com', expires: 1_900_000_000 })?.expirationDate).toBe(1_900_000_000);
    expect(toElectronCookie({ name: 's', value: 'v' })).toBeNull();
  });

  it('读失败的原因归成用户能照做的那一种', () => {
    expect(classifyCookieReadFailure(['Failed to read macOS Keychain (Chrome Safe Storage): denied'])).toBe('keychain');
    expect(classifyCookieReadFailure(['3 cookies use v20 app-bound encryption'])).toBe('app-bound');
    expect(classifyCookieReadFailure(['EPERM: operation not permitted'])).toBe('disk-access');
    expect(classifyCookieReadFailure(['weird'])).toBe('other');
  });

  it('只读出一部分:新加密锁着的那部分要说出来;只是分区 cookie 不导,不算(sweet-cookie 的原话)', () => {
    const v20 = '12 Chromium cookie(s) use v20 App-Bound Encryption and could not be decrypted. Use the extension exporter or Chrome DevTools Protocol for those cookies.';
    const partitioned = '3 partitioned Chromium cookie(s) were excluded because replay cannot preserve their partition key.';
    expect(partialReadFailure([partitioned, v20])).toBe('app-bound');
    expect(partialReadFailure([partitioned])).toBeNull();
    expect(partialReadFailure([])).toBeNull();
  });
});

/**
 * 真读一次(补丁之后的 sweet-cookie):来源写 `https://*` 就是整个配置的全部站点。
 * 用 Firefox 的库造数据 —— 它的值不加密,读的时候不碰钥匙串,测试里不会弹系统授权框。
 */
describe('#7191 sweet-cookie「全部站点」补丁(patches/@steipete__sweet-cookie@0.4.4.patch)', () => {
  function fakeFirefoxProfile(hosts: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-ff-'));
    const db = new DatabaseSync(join(dir, 'cookies.sqlite'));
    db.exec(`CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT,
      host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER,
      inBrowserElement INTEGER DEFAULT 0, sameSite INTEGER DEFAULT 0, rawSameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0)`);
    const insert = db.prepare('INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly) VALUES (?, ?, ?, ?, ?, 1, 0)');
    hosts.forEach((host, i) => insert.run(`c${i}`, `v${i}`, host, '/', 4_000_000_000));
    db.close();
    return dir;
  }

  it('一千五百个站点一次读全(逐站点拼 SQL 会撞上 SQLite 1000 层表达式深度)', async () => {
    const hosts = Array.from({ length: 1500 }, (_, i) => (i % 2 ? `.site${i}.example` : `www.site${i}.example`));
    const dir = fakeFirefoxProfile(hosts);
    try {
      const all = await getCookies({ url: 'https://*', browsers: ['firefox'], firefoxProfile: dir });
      expect(all.cookies).toHaveLength(1500);
      // 对照:按某一个站点读,只回那一个站点的 —— `*` 的「全部」不是库本来就不过滤。
      const one = await getCookies({ url: 'https://www.site0.example', browsers: ['firefox'], firefoxProfile: dir });
      expect(one.cookies.map((c) => c.name)).toEqual(['c0']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
