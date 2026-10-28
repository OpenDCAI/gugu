/**
 * @@@task-fusion (#2802) — 主题的唯一真值:咕咕写在 `<html data-theme>` 上的那个。
 *
 * 从前会话页自己存一份(它的 app-settings `theme` + localStorage `emdash-theme`),
 * 于是同一个 `<html>` 上挂着两套互不相干的标记:`data-theme="light"`(咕咕)和
 * `class="emdark"`(会话页)。CSS 层面碰巧不出事——`EmdashSessionFrame` 会把跟随咕咕的
 * emlight/emdark 打在**挂载元素**上,离得近所以赢了根上那个错的。但读 JS 的那批消费者
 * (plugin-icon 选明暗图标变体、monaco、sonner、代码高亮)拿的是会话页那份,全都拿到 emdark。
 * owner 实遇的症状:亮色主题下 Grok 的图标是**白的**,画在白底上,那一行看起来就是个洞
 * (实测 fill=#fff、data-theme=light)。
 *
 * 所以读写都收敛到这里一处。属性 = 真值,咕咕的 provider 观察它并同步自身 state,
 * 会话页的 provider 用 useSyncExternalStore 订阅它 —— 没有第二处可以漂。
 *
 * **偏好**(用户在设置里选的)与**真值**(当下到底是浅还是深)是两层。
 * 偏好存 localStorage `app-theme`,取值 `light` / `dark` / `system` / `plain-white`;真值永远是解析后的
 * `light` / `dark`,落在 `<html data-theme>` 上。选了 `system` 时真值随系统外观走,
 * 由 `startHostThemeSystemSync()` 一处负责改写属性 —— 两个 React 根都只是观察者。
 */
import { rendererLogger } from '@/lib/log';

const themeLog = rendererLogger('theme/native-appearance');

export type EffectiveTheme = 'emlight' | 'emdark';

/** 真值:当下到底是浅还是深。落在 `<html data-theme>` 上。 */
export type HostTheme = 'light' | 'dark';

/** 偏好:用户在设置里选的那一项。`system` = 跟随系统外观。 */
export type ThemePreference = HostTheme | 'system' | 'plain-white';

const HOST_THEME_STORAGE_KEY = 'app-theme';

/** @@@1424 首次启动仍是浅色 —— 三态只是把「跟随系统」重新给回用户,不改默认。 */
const DEFAULT_PREFERENCE: ThemePreference = 'light';

const preferenceListeners = new Set<() => void>();

function notifyPreferenceChanged(): void {
  for (const listener of preferenceListeners) listener();
}

function prefersDarkQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia('(prefers-color-scheme: dark)');
}

/** 系统外观当下是不是深色。拿不到 matchMedia(测试/SSR)时按浅色。 */
export function systemPrefersDark(): boolean {
  return prefersDarkQuery()?.matches === true;
}

/** 把偏好解析成明暗真值:`system` 查系统外观,素白固定用浅色。 */
export function resolveThemePreference(preference: ThemePreference): HostTheme {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return preference === 'plain-white' ? 'light' : preference;
}

/** 读用户选的那一项。存的值不认识(旧版本/被改过)时退回默认,❌ 不猜。 */
export function readThemePreference(): ThemePreference {
  if (typeof localStorage === 'undefined') return DEFAULT_PREFERENCE;
  const saved = localStorage.getItem(HOST_THEME_STORAGE_KEY);
  return saved === 'light' || saved === 'dark' || saved === 'system' || saved === 'plain-white' ? saved : DEFAULT_PREFERENCE;
}

/**
 * @@@native-appearance (#7333) — 偏好同步给主进程(mac 上照抄成 nativeTheme.themeSource,原生材质跟着它的明暗走),
 * 拿回主进程恢复 themeSource **之后**的真实明暗。偏好是 system 时用这个答案落主题:此刻 renderer 的 matchMedia 可能
 * 还停在上一次手选的明暗上(主进程改 themeSource 之后,Chromium 才异步把 prefers-color-scheme 推过来),先拿它解析
 * 就会先画错一帧。三种结果分开走,❌ 合成一个 null:
 *   no-bridge — web / 测试,没有主进程:matchMedia 就是它的系统外观真值,正常路径;
 *   ok        — 主进程答了真实明暗;
 *   failed    — 桥在、主进程没答上来(它那一侧已记原因):这次不算成功,调用方保留现有偏好与主题。
 */
type NativeAppearanceSync = { kind: 'no-bridge' } | { kind: 'ok'; system: HostTheme } | { kind: 'failed' };

export class NativeAppearanceSyncError extends Error {}

function syncNativeAppearance(preference: ThemePreference): NativeAppearanceSync {
  if (typeof window === 'undefined') return { kind: 'no-bridge' };
  const bridge = window.electronAPI?.syncThemePreference;
  if (!bridge) return { kind: 'no-bridge' };
  // 素白是浅色的表面样式;原生窗口仍消费浅/深/系统这三种外观。
  const answer = bridge(preference === 'plain-white' ? 'light' : preference);
  return answer === 'light' || answer === 'dark' ? { kind: 'ok', system: answer } : { kind: 'failed' };
}

/** 同步成功(或没有主进程)之后,偏好 → 真值。 */
function settledTheme(preference: ThemePreference, sync: Exclude<NativeAppearanceSync, { kind: 'failed' }>): HostTheme {
  if (preference !== 'system') return resolveThemePreference(preference);
  return sync.kind === 'ok' ? sync.system : resolveThemePreference('system');
}

/**
 * 偏好的变化不一定伴随真值的变化 —— 系统是浅色时,从「浅色」切到「跟随系统」解析出来还是
 * `light`,属性一个字节都不动。所以订阅属性的那批消费者收不到通知,设置界面的选中态会卡住。
 * ⇒ 偏好自带一条通知链,与属性那条并列。
 */
export function subscribeToThemePreference(onChange: () => void): () => void {
  preferenceListeners.add(onChange);
  return () => {
    preferenceListeners.delete(onChange);
  };
}

function applyEffectiveTheme(theme: HostTheme, preference: ThemePreference): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
  notifyWindowTone(theme);
}

/**
 * @@@window-tone — 无边框窗口(Windows/Linux)在网页内容画出来之前露出来的那块底色。
 * 主题真值只有这里一个写入者,所以也只有这里知道该告诉主进程什么;主进程只被告知
 * (见 electron/main.ts 同名注释)。web 构建没有这座桥,静默跳过即可 —— 那里根本没有无边框窗口。
 */
function notifyWindowTone(theme: HostTheme): void {
  if (typeof window === 'undefined') return;
  window.electronAPI?.syncWindowTone?.(theme);
}

/** 读真值。属性缺失时按浅色 —— 与 index.html 里那段引导脚本的默认一致。 */
export function readEffectiveHostTheme(): HostTheme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** 把咕咕的 `light`/`dark` 翻成会话页自身 CSS 用的 `emlight`/`emdark`。 */
export function readHostTheme(): EffectiveTheme {
  return readEffectiveHostTheme() === 'dark' ? 'emdark' : 'emlight';
}

export function subscribeToHostTheme(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}

/** 写偏好,并把解析出来的真值落到属性上。返回落下去的那个真值。 */
export function writeThemePreference(preference: ThemePreference): HostTheme {
  const sync = syncNativeAppearance(preference);
  // 主进程没跟上:不写偏好、不动主题,响亮报错(调用方是一次点击 / 命令,错误进全局错误捕获与日志)。
  if (sync.kind === 'failed') {
    throw new NativeAppearanceSyncError(`主进程没能同步主题偏好 ${preference};偏好与主题保持原样`);
  }
  const resolved = settledTheme(preference, sync);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(HOST_THEME_STORAGE_KEY, preference);
  }
  applyEffectiveTheme(resolved, preference);
  notifyPreferenceChanged();
  return resolved;
}

/** 手动选定一个具体的明暗态(= 偏好落成 light/dark,不再跟随系统)。 */
export function writeHostTheme(next: EffectiveTheme): void {
  writeThemePreference(next === 'emdark' ? 'dark' : 'light');
}

/**
 * 「跟随系统」的唯一执行处:系统外观一变,就把新真值写回属性,其余人照旧只观察属性。
 *
 * 两个 React 根都会调它,所以按引用计数做成幂等 —— 监听器只挂一份,最后一个撤了才摘。
 * ❌ 别在别处再挂一个 `prefers-color-scheme` 监听:那就又有第二处能改真值了。
 */
let systemSyncRefCount = 0;
let detachSystemSync: (() => void) | null = null;

export function startHostThemeSystemSync(): () => void {
  const mq = prefersDarkQuery();
  if (!mq) return () => {};

  systemSyncRefCount += 1;
  if (!detachSystemSync) {
    const handler = () => {
      if (readThemePreference() !== 'system') return;
      applyEffectiveTheme(systemPrefersDark() ? 'dark' : 'light', 'system');
    };
    mq.addEventListener('change', handler);
    detachSystemSync = () => mq.removeEventListener('change', handler);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    systemSyncRefCount -= 1;
    if (systemSyncRefCount === 0 && detachSystemSync) {
      detachSystemSync();
      detachSystemSync = null;
    }
  };
}

/**
 * 把存下来的偏好解析成真值落到属性上。
 * 属性缺失时❌不能默认浅色 —— 存的可能是「跟随系统」而系统正是深色。
 */
export function hydrateHostTheme(): HostTheme {
  const preference = readThemePreference();
  const sync = syncNativeAppearance(preference);
  // 启动恢复时主进程没跟上:属性已经由 index.html 的引导脚本落过,保留它,只把失败报出来(❌ 在这里抛:会把整个壳拖垮)。
  if (sync.kind === 'failed') {
    themeLog.error({ preference }, '启动时主进程没能同步主题偏好;保留当前主题,原生外观可能与它不一致');
    return readEffectiveHostTheme();
  }
  const resolved = settledTheme(preference, sync);
  applyEffectiveTheme(resolved, preference);
  return resolved;
}

/**
 * 翻转真值,并把偏好落成翻到的那一个 —— 翻转是一次**手动选定**,选完就不再跟随系统。
 * (从「跟随系统」翻,翻的是当下解析出来的那个真值的反面。)
 */
export function nextHostTheme(current: EffectiveTheme): EffectiveTheme {
  return current === 'emlight' ? 'emdark' : 'emlight';
}

/** 翻转主题,返回翻到的那个。DOM 写入,不会失败。 */
export function toggleHostTheme(): EffectiveTheme {
  const next = nextHostTheme(readHostTheme());
  writeHostTheme(next);
  return next;
}
