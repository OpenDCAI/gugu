export const BROWSER_PARTITION_PREFIX = 'persist:gugu-browser';
/** 改名前的分区前缀。只用来把磁盘上的旧分区目录搬到新名字下(见 browser-partition-cleanup.ts)。 */
export const LEGACY_BROWSER_PARTITION_PREFIX = 'persist:emdash-browser';

export const DEFAULT_BROWSER_PROFILE_ID = 'default';
export const BROWSER_ISOLATED_PROFILE_ID = 'isolated-per-session';

export type BrowserProfile = {
  id: string;
  name: string;
};

export const DEFAULT_BROWSER_PROFILES: BrowserProfile[] = [
  { id: DEFAULT_BROWSER_PROFILE_ID, name: 'Default' },
];

export type BrowserProfileSelection = string;

export const BROWSER_PROFILE_PARTITION = `${BROWSER_PARTITION_PREFIX}-profile`;

export type BrowserNavigationProtocol = 'about:' | 'file:' | 'http:' | 'https:';

export type BrowserUrlNormalizeResult =
  | { ok: true; url: string; protocol: BrowserNavigationProtocol }
  | { ok: false; reason: BrowserUrlRejectionReason };

export type BrowserUrlRejectionReason =
  | 'empty'
  | 'invalid-url'
  | 'unsupported-protocol'
  | 'unsupported-file-url';

export type BrowserUrlNormalizeOptions = {
  allowFileUrls?: boolean;
  allowSearchQueries?: boolean;
};

/**
 * 一枚浏览器页签**可以持有**的地址:http(s),外加本地页面(`file:`)。
 *
 * 单独起名而不是每处call site 各写一遍 options,是因为这条规则必须**处处一致**:会话建
 * 快照、恢复、更新、`<webview>` 准入、页内导航、重载判定,任何一处漏了 `allowFileUrls`,
 * 那一处就把 `file:` 判成非法 —— 而它们各自的兜底又都是「悄悄换成默认页」或「什么都不
 * 做」。#4090 实机实证:宿主这边放行了 `file:`,`createBrowserSessionSnapshot` 没放行,
 * 于是 agent 要打开的本地页面被静默替换成默认页,MCP 那头还回了 success。
 *
 * ❌ 别把它用在地址栏那条路上:那里还要分辨「这是网址还是搜索词」,是另一条规则。
 */
export const BROWSER_TAB_URL_OPTIONS: BrowserUrlNormalizeOptions = {
  allowFileUrls: true,
  allowSearchQueries: false,
};

export type BrowserSessionIdentity = {
  browserId: string;
  projectId: string;
  workspaceId: string;
  /** 这个浏览器页签属于哪条会话(按会话隔离的配置用它分区)。 */
  sessionId: string;
};

export type BrowserLoadError = {
  code?: number;
  description: string;
  url?: string;
};

/**
 * 当前这个缩放是谁定的。
 *
 * 分开记不是记账癖 —— 两者的生命周期正好相反:**自动**缩放是为「让这一页装进面板」算出来的,
 * 换一页就得重算(上一页的 34% 带到下一页是错的);**用户**定的缩放要跨页保持,任何自动逻辑
 * 都不许覆盖。光看数值分不出这两者:34% 既可能是算出来的,也可能是用户自己调的。
 */
export type BrowserZoomSource = 'auto' | 'user';

export type BrowserSessionSnapshot = BrowserSessionIdentity & {
  profileId: BrowserProfileSelection;
  partition: string;
  currentUrl: string;
  title: string;
  faviconUrl?: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  zoomSource: BrowserZoomSource;
  /**
   * 当前这一页在 100% 缩放下自己要的布局宽度(CSS px),没量到就是 undefined。
   *
   * 必须记住这个**原始**宽度,而不是每次拖宽面板时现量:缩放会把布局视口一起放大(见
   * browserFitZoomFactor 的注释),所以缩过之后再量,量到的是「缩放后的页面」而不是页面本身
   * —— 那样只能越缩越小,拖宽面板后再也回不去。
   */
  pageLayoutWidthPx?: number;
  loadError?: BrowserLoadError;
  createdAt: number;
  updatedAt: number;
};

export type BrowserSessionRestoreInput = Omit<
  BrowserSessionSnapshot,
  'zoomFactor' | 'zoomSource' | 'pageLayoutWidthPx'
> & {
  zoomFactor?: number;
  zoomSource?: BrowserZoomSource;
};

export type BrowserDataClearKind = 'storage' | 'cookies' | 'cache';

export function isBrowserDataClearKind(kind: string): kind is BrowserDataClearKind {
  return kind === 'storage' || kind === 'cookies' || kind === 'cache';
}

// Granular categories for clearing browsing data across the in-app browser
// profiles from settings. `all` wipes everything; the rest map to Electron
// `session.clearData({ dataTypes })` groups.
export type BrowsingDataKind = 'all' | 'cookies' | 'siteData' | 'cache';

export function isBrowsingDataKind(value: string): value is BrowsingDataKind {
  return value === 'all' || value === 'cookies' || value === 'siteData' || value === 'cache';
}

export type BrowserDiagnosticsLevel = 'info' | 'warning' | 'error';

export type BrowserDiagnosticsEntry = {
  id: string;
  browserId: string;
  level: BrowserDiagnosticsLevel;
  source: 'console' | 'navigation' | 'network';
  message: string;
  url?: string;
  line?: number;
  column?: number;
  timestamp: number;
};

export const BROWSER_DEFAULT_URL = 'about:blank';
export const BROWSER_DEFAULT_SEARCH_URL = 'https://www.google.com/search';

const BROWSER_RESERVED_SCHEMES = new Set(['about', 'data', 'file', 'http', 'https', 'javascript']);

export const BROWSER_ZOOM_FACTORS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const;

export const BROWSER_DEFAULT_ZOOM_FACTOR = 1;

const ZOOM_EPSILON = 0.001;

export function normalizeBrowserZoomFactor(factor: number | undefined): number {
  if (factor === undefined || !Number.isFinite(factor)) return BROWSER_DEFAULT_ZOOM_FACTOR;
  const min = BROWSER_ZOOM_FACTORS[0];
  const max = BROWSER_ZOOM_FACTORS[BROWSER_ZOOM_FACTORS.length - 1];
  return Math.min(max, Math.max(min, factor));
}

export function nextBrowserZoomFactor(factor: number): number {
  const current = normalizeBrowserZoomFactor(factor);
  for (const step of BROWSER_ZOOM_FACTORS) {
    if (step > current + ZOOM_EPSILON) return step;
  }
  return BROWSER_ZOOM_FACTORS[BROWSER_ZOOM_FACTORS.length - 1];
}

export function previousBrowserZoomFactor(factor: number): number {
  const current = normalizeBrowserZoomFactor(factor);
  for (let i = BROWSER_ZOOM_FACTORS.length - 1; i >= 0; i--) {
    if (BROWSER_ZOOM_FACTORS[i] < current - ZOOM_EPSILON) return BROWSER_ZOOM_FACTORS[i];
  }
  return BROWSER_ZOOM_FACTORS[0];
}

export function canZoomIn(factor: number): boolean {
  return (
    normalizeBrowserZoomFactor(factor) <
    BROWSER_ZOOM_FACTORS[BROWSER_ZOOM_FACTORS.length - 1] - ZOOM_EPSILON
  );
}

export function canZoomOut(factor: number): boolean {
  return normalizeBrowserZoomFactor(factor) > BROWSER_ZOOM_FACTORS[0] + ZOOM_EPSILON;
}

export function isDefaultBrowserZoomFactor(factor: number): boolean {
  return Math.abs(normalizeBrowserZoomFactor(factor) - BROWSER_DEFAULT_ZOOM_FACTOR) < ZOOM_EPSILON;
}

export function formatBrowserZoomPercent(factor: number): string {
  return `${Math.round(normalizeBrowserZoomFactor(factor) * 100)}%`;
}

export function normalizeBrowserZoomSource(
  source: BrowserZoomSource | undefined,
  zoomFactor: number
): BrowserZoomSource {
  if (source === 'auto' || source === 'user') return source;
  // 旧快照(没这个字段)只能从数值反推:不是 100% 就说明当时有人调过 —— 把它当成用户定的,
  // ❌ 别默认成 auto:那会在恢复后的第一次导航里把用户存了很久的缩放悄悄重置掉。
  return isDefaultBrowserZoomFactor(zoomFactor) ? 'auto' : 'user';
}

/**
 * 让页面**整幅**装进面板所需的缩放;装得下就返回 null(不放大)。
 *
 * 为什么缩放能解决「网页只有一半」:`<webview>` 的 zoom 不只是把像素画小,它同时把**布局视口**
 * 按同样的比例放大 —— 实机量过,424px 的面板在 zoom 0.5 下,内嵌页自己量到的 innerWidth 是 850。
 * 所以这条和手机浏览器打开一张老式桌面页是同一件事:给页面一个够宽的视口,再整体缩进面板里。
 *
 * ⚠️ 它只该用在**没有 `<meta name="viewport">`** 的页面上(见 browser-page-fit.ts)。
 * 判据 ❌ 不能是「内容比视口宽」:响应式页面里一段过宽的代码块、一张宽表格都会让 scrollWidth
 * 超出视口,按那个判据整页会被缩到看不清,而页面本身排得好好的。没有 viewport meta 才是
 * 「这一页从没被告知怎么变窄」的确证 —— 实测:百度首页无 viewport meta,在 425px 面板里
 * 排成 1250px 被裁掉 2/3;github 与 mdn 都有,同一个面板同一个宽度下 425 = 425,分毫不差。
 */
export function browserFitZoomFactor(input: {
  paneWidthPx: number;
  pageLayoutWidthPx: number;
}): number | null {
  const { paneWidthPx, pageLayoutWidthPx } = input;
  if (!Number.isFinite(paneWidthPx) || !Number.isFinite(pageLayoutWidthPx)) return null;
  if (paneWidthPx <= 0 || pageLayoutWidthPx <= 0) return null;
  // 装得下就不动。❌ 不放大:页面比面板窄时把它撑满是替用户做主,而且 100% 才是浏览器的常态。
  if (pageLayoutWidthPx <= paneWidthPx) return null;
  return normalizeBrowserZoomFactor(paneWidthPx / pageLayoutWidthPx);
}

export function normalizeBrowserUrl(
  rawInput: string,
  options: BrowserUrlNormalizeOptions = {}
): BrowserUrlNormalizeResult {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  if (trimmed === 'about:blank') {
    return { ok: true, url: BROWSER_DEFAULT_URL, protocol: 'about:' };
  }

  if (options.allowSearchQueries !== false && isSearchQuery(trimmed)) {
    return { ok: true, url: browserSearchUrl(trimmed), protocol: 'https:' };
  }

  const candidate = withDefaultScheme(trimmed);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return { ok: true, url: parsed.toString(), protocol: parsed.protocol };
  }

  if (parsed.protocol === 'file:') {
    if (!options.allowFileUrls) {
      return { ok: false, reason: 'unsupported-file-url' };
    }
    return { ok: true, url: parsed.toString(), protocol: 'file:' };
  }

  return { ok: false, reason: 'unsupported-protocol' };
}

/**
 * 两个网址算不算同一个地址(agent 再开一次同一页时切回已开的页签)。只归一最基本的:scheme、host 的大小写
 * 与默认端口(normalizeBrowserUrl 已做),外加路径末尾的 `/`。query、hash 是页面的一部分,❌ 去掉。
 */
export function browserAddressKey(rawUrl: string): string {
  const normalized = normalizeBrowserUrl(rawUrl, BROWSER_TAB_URL_OPTIONS);
  if (!normalized.ok) return rawUrl.trim();
  const url = new URL(normalized.url);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}

export function makeBrowserSessionIdentity(input: {
  projectId: string;
  workspaceId: string;
  sessionId: string;
  browserId?: string;
}): BrowserSessionIdentity {
  return {
    browserId: input.browserId ?? crypto.randomUUID(),
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
  };
}

export function browserProfilePartition(profileId: string): string {
  if (profileId === DEFAULT_BROWSER_PROFILE_ID) return BROWSER_PROFILE_PARTITION;
  return `${BROWSER_PARTITION_PREFIX}-profile-${profileId}`;
}

export function makeIsolatedBrowserPartition(identity: BrowserSessionIdentity): string {
  return [
    BROWSER_PARTITION_PREFIX,
    'isolated',
    partitionComponent(identity.projectId),
    partitionComponent(identity.workspaceId),
    partitionComponent(identity.sessionId),
  ].join('-');
}

export function browserPartitionForProfile(
  identity: BrowserSessionIdentity,
  profileId: BrowserProfileSelection
): string {
  if (profileId === BROWSER_ISOLATED_PROFILE_ID) return makeIsolatedBrowserPartition(identity);
  return browserProfilePartition(profileId);
}

export function isNamedBrowserProfileId(value: string): boolean {
  return value !== BROWSER_ISOLATED_PROFILE_ID && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

export function normalizeBrowserProfileSelection(
  profileId: string | undefined,
  profiles?: readonly BrowserProfile[]
): BrowserProfileSelection {
  if (profileId === BROWSER_ISOLATED_PROFILE_ID) {
    return profileId;
  }
  if (profileId && isNamedBrowserProfileId(profileId)) {
    if (!profiles || profiles.some((profile) => profile.id === profileId)) return profileId;
  }
  return (
    profiles?.find((profile) => isNamedBrowserProfileId(profile.id))?.id ??
    DEFAULT_BROWSER_PROFILE_ID
  );
}

export function browserProfileLabel(
  profileId: string,
  profiles: readonly BrowserProfile[]
): string {
  if (profileId === BROWSER_ISOLATED_PROFILE_ID) return 'Isolated per task';
  return profiles.find((profile) => profile.id === profileId)?.name ?? profileId;
}

export function createBrowserSessionSnapshot(input: {
  identity: BrowserSessionIdentity;
  profileId?: BrowserProfileSelection;
  currentUrl?: string;
  now?: number;
}): BrowserSessionSnapshot {
  const now = input.now ?? Date.now();
  const profileId = normalizeBrowserProfileSelection(input.profileId);
  const normalized = normalizeBrowserUrl(
    input.currentUrl ?? BROWSER_DEFAULT_URL,
    BROWSER_TAB_URL_OPTIONS
  );
  return {
    ...input.identity,
    profileId,
    partition: browserPartitionForProfile(input.identity, profileId),
    currentUrl: normalized.ok ? normalized.url : BROWSER_DEFAULT_URL,
    title: '',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: BROWSER_DEFAULT_ZOOM_FACTOR,
    zoomSource: 'auto',
    createdAt: now,
    updatedAt: now,
  };
}

function partitionComponent(value: string): string {
  const safe = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || 'unknown';
}

function browserSearchUrl(query: string): string {
  const url = new URL(BROWSER_DEFAULT_SEARCH_URL);
  url.searchParams.set('q', query);
  return url.toString();
}

function isSearchQuery(input: string): boolean {
  if (isLocalhostLike(input)) return false;

  const scheme = explicitSchemePrefix(input);
  if (scheme) {
    return /\s/.test(input) && !BROWSER_RESERVED_SCHEMES.has(scheme.toLowerCase());
  }

  return !looksLikeNavigableHost(input);
}

function looksLikeNavigableHost(input: string): boolean {
  const hostLike = input.split(/[/?#]/, 1)[0].toLowerCase();
  if (hostLike.length === 0 || /\s/.test(hostLike)) return false;
  if (hostLike.startsWith('[') && hostLike.includes(']')) return true;
  return hostLike.includes('.');
}

function withDefaultScheme(input: string): string {
  if (isLocalhostLike(input)) {
    return `http://${input}`;
  }
  if (explicitSchemePrefix(input)) {
    return input;
  }
  return `https://${input}`;
}

function explicitSchemePrefix(input: string): string | null {
  const colonIndex = input.indexOf(':');
  if (colonIndex <= 0) return null;
  const prefix = input.slice(0, colonIndex);
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*$/.test(prefix)) return null;
  if (prefix.includes('.')) return null;
  return prefix;
}

function isLocalhostLike(input: string): boolean {
  const hostLike = input.split(/[/?#]/, 1)[0].toLowerCase();
  return (
    hostLike === 'localhost' ||
    hostLike.startsWith('localhost:') ||
    hostLike === '127.0.0.1' ||
    hostLike.startsWith('127.0.0.1:') ||
    hostLike === '[::1]' ||
    hostLike.startsWith('[::1]:') ||
    hostLike.endsWith('.localhost') ||
    hostLike.includes('.localhost:')
  );
}
