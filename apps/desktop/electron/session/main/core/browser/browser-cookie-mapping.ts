/**
 * #7191「从默认浏览器导入登录」里不碰 Electron 的那几步(纯函数,便于测):认出默认浏览器是哪一家、
 * 那一家最近用的是哪个用户配置、读到的 cookie 怎么换成 `session.cookies.set` 要的形状。
 * 读 cookie 本身(解密、钥匙串、快照拷贝)全交给 `@steipete/sweet-cookie`(MIT),这里不写。
 */

/** sweet-cookie 认得的读法:哪个后端、Chromium 系里具体哪一家。 */
export type CookieSource =
  | { backend: 'chrome'; chromium: 'chrome' | 'brave' | 'arc' | 'chromium' | 'dia' }
  | { backend: 'edge' }
  | { backend: 'firefox' }
  | { backend: 'safari' };

/**
 * `app.getApplicationNameForProtocol('https://')` 给的名字(「Google Chrome」「Safari」「Microsoft Edge」…)→ 读法。
 * 认不出 = null(界面说「暂不支持从 X 导入」,❌ 猜一家去读)。顺序有讲究:Edge / Brave 的名字里都可能带 Chrome 字样。
 */
export function cookieSourceForBrowserName(name: string): CookieSource | null {
  const lower = name.toLowerCase();
  if (lower.includes('edge')) return { backend: 'edge' };
  if (lower.includes('brave')) return { backend: 'chrome', chromium: 'brave' };
  if (lower.includes('firefox')) return { backend: 'firefox' };
  if (lower.includes('safari')) return { backend: 'safari' };
  if (/\barc\b/.test(lower)) return { backend: 'chrome', chromium: 'arc' };
  if (/\bdia\b/.test(lower)) return { backend: 'chrome', chromium: 'dia' };
  if (lower.includes('chromium')) return { backend: 'chrome', chromium: 'chromium' };
  if (lower.includes('chrome')) return { backend: 'chrome', chromium: 'chrome' };
  return null;
}

/**
 * Chromium 系浏览器的数据根目录(里面有 `Local State`)。只用来找「最近用的那个用户配置」——
 * 一台电脑上 Chrome 常开着好几个人的配置,❌ 一律导 Default(那多半不是在用的那个)。
 */
export function chromiumUserDataRoot(
  source: CookieSource,
  platform: NodeJS.Platform,
  dirs: { home: string; localAppData?: string },
): string | null {
  const id = source.backend === 'edge' ? 'edge' : source.backend === 'chrome' ? source.chromium : null;
  if (!id) return null;
  const join = (...parts: string[]) => parts.join(platform === 'win32' ? '\\' : '/');
  if (platform === 'darwin') {
    const roots: Record<string, string> = {
      chrome: 'Google/Chrome',
      brave: 'BraveSoftware/Brave-Browser',
      arc: 'Arc/User Data',
      chromium: 'Chromium',
      dia: 'Dia/User Data',
      edge: 'Microsoft Edge',
    };
    return roots[id] ? join(dirs.home, 'Library', 'Application Support', roots[id]) : null;
  }
  if (platform === 'win32') {
    if (!dirs.localAppData) return null;
    const roots: Record<string, string> = {
      chrome: 'Google\\Chrome\\User Data',
      brave: 'BraveSoftware\\Brave-Browser\\User Data',
      chromium: 'Chromium\\User Data',
      edge: 'Microsoft\\Edge\\User Data',
    };
    return roots[id] ? join(dirs.localAppData, roots[id]) : null;
  }
  const roots: Record<string, string> = {
    chrome: 'google-chrome',
    brave: 'BraveSoftware/Brave-Browser',
    chromium: 'chromium',
    edge: 'microsoft-edge',
  };
  return roots[id] ? join(dirs.home, '.config', roots[id]) : null;
}

/**
 * 交给 sweet-cookie 的「读哪个 Chromium 配置」;null = 这台电脑上读不了这一家(界面按「暂不支持」处理)。
 * - macOS / Linux:配置名即可,`chromiumBrowser` 已经选定是哪一家。
 * - Windows:它的 chrome 后端不认 `chromiumBrowser`、只认 Chrome 自己的目录(它的 README:Brave 等要给完整路径)
 *   ⇒ 一律给完整路径;认不出数据目录的(Windows 上的 Arc 等)返回 null —— ❌ 退回去把 Chrome 的登录当成它的导进来。
 */
export function chromiumProfileOption(
  source: CookieSource,
  platform: NodeJS.Platform,
  root: string | null,
  profile: string | null,
): { chromeProfile?: string; edgeProfile?: string } | null {
  if (source.backend === 'edge') return profile ? { edgeProfile: profile } : {};
  if (source.backend !== 'chrome') return {};
  if (platform === 'win32') return root ? { chromeProfile: `${root}\\${profile ?? 'Default'}` } : null;
  return profile ? { chromeProfile: profile } : {};
}

/** `Local State` 里记着的最近用过的配置目录名(「Default」「Profile 1」…);读不出 = null。 */
export function lastUsedChromiumProfile(localStateJson: string): string | null {
  try {
    const parsed = JSON.parse(localStateJson) as { profile?: { last_used?: unknown } };
    const lastUsed = parsed.profile?.last_used;
    return typeof lastUsed === 'string' && lastUsed.trim() ? lastUsed : null;
  } catch {
    return null;
  }
}

/** sweet-cookie 读出来的一条(只列这里用到的字段)。 */
export interface ReadCookie {
  name: string;
  value: string;
  domain?: string;
  hostOnly?: boolean;
  path?: string;
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** Electron `CookiesSetDetails` 里这里会填的那些。 */
export interface ElectronCookieDetails {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

/**
 * 一条读到的 cookie → 一次 `session.cookies.set`。放不进去的(没有域名)返回 null,算「跳过」。
 *
 * - 只认一个主机的 cookie(hostOnly)❌ 带 `domain`:Electron 见到 domain 就把它变成整个域都带的那种。
 * - `SameSite=None` 浏览器要求必须 secure,原样照搬;`__Secure-` / `__Host-` 前缀同理只能落在 https 上。
 * - 没有过期时间 = 会话 cookie,照样导(关掉咕咕就没了,与原浏览器一致)。
 */
export function toElectronCookie(cookie: ReadCookie): ElectronCookieDetails | null {
  const domain = cookie.domain?.replace(/^\./, '').trim();
  if (!domain || !cookie.name) return null;
  const path = cookie.path?.startsWith('/') ? cookie.path : '/';
  const secure = cookie.secure === true || cookie.sameSite === 'None' || /^__(Secure|Host)-/.test(cookie.name);
  const sameSite =
    cookie.sameSite === 'Strict' ? 'strict' : cookie.sameSite === 'Lax' ? 'lax' : cookie.sameSite === 'None' ? 'no_restriction' : 'unspecified';
  return {
    url: `${secure ? 'https' : 'http'}://${domain}${path}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain }),
    path,
    secure,
    httpOnly: cookie.httpOnly === true,
    ...(typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) ? { expirationDate: cookie.expires } : {}),
    sameSite,
  };
}

/** 读失败时 sweet-cookie 给的英文诊断 → 用户能照做的那一种原因(界面按它出文案)。 */
export type CookieReadFailure = 'keychain' | 'app-bound' | 'disk-access' | 'not-found' | 'other';

/**
 * 读到了一部分、其余没解开时,没解开的原因(人能照做的那种);null = 读到的就是能导的全部(分区 cookie 这类本来就不导的不算)。
 * 例:Windows 上新版 Chrome 的大部分 cookie 用新加密锁着,只有几条老的能解开 —— 照样导,但要说清,❌ 报成「全部导入了」。
 */
export function partialReadFailure(warnings: readonly string[]): 'keychain' | 'app-bound' | 'disk-access' | null {
  const failure = classifyCookieReadFailure(warnings);
  return failure === 'keychain' || failure === 'app-bound' || failure === 'disk-access' ? failure : null;
}

export function classifyCookieReadFailure(warnings: readonly string[]): CookieReadFailure {
  const text = warnings.join('\n');
  if (/keychain|keyring|safe storage/i.test(text)) return 'keychain';
  if (/v20|app-bound|app bound/i.test(text)) return 'app-bound';
  if (/operation not permitted|EPERM|EACCES|full disk/i.test(text)) return 'disk-access';
  if (/no cookie|not found|ENOENT|missing/i.test(text)) return 'not-found';
  return 'other';
}
