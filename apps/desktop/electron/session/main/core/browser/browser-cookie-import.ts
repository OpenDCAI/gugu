import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { app } from 'electron';
import { getCookies } from '@steipete/sweet-cookie';
import { log } from '@main/lib/logger';
import { browserProfilePartition, isNamedBrowserProfileId } from '@shared/browser';
import { configureBrowserProfileSession } from './browser-profile-session';
import {
  chromiumProfileOption,
  chromiumUserDataRoot,
  classifyCookieReadFailure,
  cookieSourceForBrowserName,
  lastUsedChromiumProfile,
  partialReadFailure,
  toElectronCookie,
  type CookieReadFailure,
  type CookieSource,
} from './browser-cookie-mapping';

/**
 * #7191「从默认浏览器导入登录」—— 一键全量(owner 2026-10-15「懒人式,一次性导入」,❌ 列站点让人勾)。
 *
 * 默认浏览器自动认;它里面全部 cookie 一次导进指定的浏览器配置;只报导了多少、跳过多少。导别人的账号 = 切到另一份
 * 配置再导一次。一次性快照,❌ 同步;只导 cookie,❌ 密码。
 *
 * 读 cookie 全交给 `@steipete/sweet-cookie`(解密、macOS 钥匙串、Windows DPAPI、先拷贝快照再读)。它只按站点读,
 * 一个真实配置有上千个站点,逐个拼进一条 SQL 会超出 SQLite 的表达式深度(1000,实测)⇒ 打了一个补丁:
 * 来源写 `https://*` 就读全部(patches/@steipete__sweet-cookie@0.4.4.patch),整个配置只读一次、钥匙串只问一次。
 */

export type DefaultBrowserInfo = { name: string; supported: boolean };

export type CookieImportResult =
  | { ok: true; browser: string; imported: number; skipped: number; partial: 'keychain' | 'app-bound' | 'disk-access' | null }
  | { ok: false; browser: string; reason: 'unsupported-browser' | CookieReadFailure; detail?: string };

function userDataRoot(source: CookieSource): string | null {
  return chromiumUserDataRoot(source, process.platform, { home: homedir(), localAppData: process.env.LOCALAPPDATA });
}

/** 认不出默认浏览器(没设、或者是咕咕自己)时名字为空。 */
export function defaultBrowser(): DefaultBrowserInfo {
  const name = app.getApplicationNameForProtocol('https://').trim();
  const source = name ? cookieSourceForBrowserName(name) : null;
  return { name, supported: source !== null && chromiumProfileOption(source, process.platform, userDataRoot(source), null) !== null };
}

/** Chromium 系:读哪个配置(见 `chromiumProfileOption`);null = 这台电脑上读不了。 */
async function chromiumProfileFor(source: CookieSource): Promise<{ chromeProfile?: string; edgeProfile?: string } | null> {
  if (source.backend !== 'chrome' && source.backend !== 'edge') return {};
  const root = userDataRoot(source);
  const sep = process.platform === 'win32' ? '\\' : '/';
  const localState = root ? await readFile(`${root}${sep}Local State`, 'utf8').catch(() => null) : null;
  return chromiumProfileOption(source, process.platform, root, localState ? lastUsedChromiumProfile(localState) : null);
}

export async function importDefaultBrowserCookies(profileId: string): Promise<CookieImportResult> {
  if (!isNamedBrowserProfileId(profileId)) throw new Error(`not a browser profile you can import into: ${profileId}`);
  const { name } = defaultBrowser();
  const source = name ? cookieSourceForBrowserName(name) : null;
  if (!source) return { ok: false, browser: name, reason: 'unsupported-browser' };

  const profile = await chromiumProfileFor(source);
  if (!profile) return { ok: false, browser: name, reason: 'unsupported-browser' };
  const { cookies, warnings } = await getCookies({
    url: 'https://*',
    browsers: [source.backend],
    ...(source.backend === 'chrome' ? { chromiumBrowser: source.chromium } : {}),
    ...profile,
    // macOS 钥匙串会弹系统授权框,人要输密码:给足时间,❌ 默认的几秒就判失败。
    timeoutMs: 120_000,
  });
  log.info('Cookie import: read the default browser', {
    browser: name,
    profile: profile.chromeProfile ?? profile.edgeProfile ?? null,
    read: cookies.length,
    // 只记诊断,❌ 记任何 cookie 的值(sweet-cookie 的 warnings 本身不含值)。
    warnings,
  });
  if (cookies.length === 0) {
    return { ok: false, browser: name, reason: classifyCookieReadFailure(warnings), detail: warnings[0] };
  }

  const session = configureBrowserProfileSession(browserProfilePartition(profileId));
  let imported = 0;
  let skipped = 0;
  for (const cookie of cookies) {
    const details = toElectronCookie(cookie);
    if (!details) {
      skipped += 1;
      continue;
    }
    try {
      await session.cookies.set(details);
      imported += 1;
    } catch {
      skipped += 1;
    }
  }
  await session.cookies.flushStore();
  const partial = partialReadFailure(warnings);
  log.info('Cookie import: done', { browser: name, profileId, imported, skipped, partial });
  return { ok: true, browser: name, imported, skipped, partial };
}
