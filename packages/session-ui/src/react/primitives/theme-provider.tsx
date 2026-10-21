/**
 * ThemeProvider — self-contained theme manager for @gugu/session-ui.
 *
 * CONTRACT
 * --------
 * import = CSS loaded: just importing this module pulls in the full CSS
 * stack as side-effects (palette vars, semantic aliases, VE globals, fonts,
 * typography, overflow-fade). No separate CSS import is required.
 *
 * mount  = theme applied: mounting the component applies the active theme's
 * selector class. All @gugu/session-ui primitives work immediately within the tree.
 *
 * THEME APPLICATION TARGET
 * ------------------------
 * By default (target="documentElement") the theme class is applied to
 * <html>, so portal-rendered UI (dropdowns, popovers, dialogs from
 * @base-ui/react) inherits the correct tokens without manual wiring.
 *
 * Use target="wrapper" when you want the theme scoped to a wrapper element
 * only (e.g. Storybook surface decorators, embedded widgets).
 *
 * USAGE
 * -----
 *   // Uncontrolled — ThemeProvider manages its own state:
 *   <ThemeProvider defaultTheme="dark"><App /></ThemeProvider>
 *
 *   // Controlled — an external owner drives the theme (e.g. Storybook globals):
 *   <ThemeProvider theme={colorMode}><Story /></ThemeProvider>
 *
 *   // Access theme inside the tree:
 *   const { themeId, setTheme, toggle } = useTheme();
 *
 * SSR NOTE
 * --------
 * documentElement mode is guarded with typeof document checks and is safe
 * to render on the server (no class will be applied server-side).
 *
 * SINGLE-PROVIDER ASSUMPTION
 * --------------------------
 * Only one ThemeProvider with target="documentElement" should be mounted at
 * a time — nested providers would compete for the <html> class.
 */

// ── CSS side-effects ─────────────────────────────────────────────────────────
// Importing this module loads the full @gugu/session-ui CSS stack.
// 咕咕按源码消费本包(#2802 并入本体后没有 lib build),所以这条导入图就是唯一那条:
// vite 的 VE 插件在应用那一次 rollup 里就地抽 CSS。应用入口若不经过本模块,
// 需自行 `import '@gugu/session-ui/styles/global'` + 下面这几个纯 CSS 文件。
//
// VE barrel: layers order, non-color token contract, surfaces, reset/base
// element defaults, sx() sprinkles atoms, animation keyframes, SVG helpers.
import '@session-ui/styles/global.css';
// Generated palette ramps + per-theme semantic aliases (wrapped in @layer tokens).
import '@session-ui/theme/__generated__/theme.css';
import '@session-ui/theme/__generated__/semantic.css';
// JetBrains Mono variable font + structural keyframes (accordion, panel-blur).
import '@session-ui/styles/theme.base.css';
// Semantic typography role classes (.text-role-body, .text-role-h1, etc.).
import '@session-ui/styles/typography.css';
// Scroll-aware overflow-fade utility (.scroll-fade / .scroll-fade__viewport).
import '@session-ui/styles/effects/overflow-fade.css';
import { cx } from '@session-ui/styles/utilities/cx';
// ── Component ────────────────────────────────────────────────────────────────
import { THEME_MANIFEST } from '@session-ui/theme/themes/registry';
import type { ThemeId } from '@session-ui/theme/themes/registry';
import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';

// Re-export for consumers that want to enumerate themes.
export type { ThemeId };
export { THEME_MANIFEST };

interface ThemeContextValue {
  /** Active theme id (e.g. "light" | "dark"). */
  themeId: ThemeId;
  /** Change to a specific theme id. */
  setTheme: (id: ThemeId) => void;
  /** Toggle between available themes in manifest order. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Returns the active theme context. Must be called inside a ThemeProvider.
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside a ThemeProvider');
  }
  return ctx;
}

/**
 * Returns the CSS selector class for the active theme (e.g. `"emlight"` or
 * `"emdark"`), or an empty string when called outside a ThemeProvider.
 *
 * Designed for portal elements that need to inherit the theme when they render
 * outside the ThemeProvider's wrapper element. Apply the returned class to the
 * outermost element of the portal so theme-scoped CSS tokens resolve correctly.
 *
 * In documentElement mode (the default) the theme class is already on <html>,
 * so all portals inherit it automatically — this hook returns an empty string
 * and has no effect in that case.
 */
export function usePortalThemeClass(): string {
  const ctx = useContext(ThemeContext);
  if (!ctx) return '';
  const entry = THEME_MANIFEST.find((e) => e.id === ctx.themeId) ?? THEME_MANIFEST[0]!;
  return entry.selector.replace(/^\./, '');
}

export interface ThemeProviderProps {
  /**
   * Controlled theme id. When provided, the component is fully controlled —
   * the class always reflects this value and internal state is kept in sync.
   * Use this when an external owner (e.g. Storybook globals) drives the theme.
   */
  theme?: ThemeId;
  /**
   * Uncontrolled initial theme id. Only used on the first render.
   * Defaults to the first entry in the manifest ("light").
   */
  defaultTheme?: ThemeId;
  /**
   * Where to apply the active theme class.
   *
   * "documentElement" (default) — applies the class to <html> so portal-rendered
   * elements (dropdowns, dialogs, popovers from @base-ui/react) are themed
   * automatically. Children are rendered as-is; className/style props are
   * forwarded to the optional wrapper element rendered when either is present.
   *
   * "wrapper" — applies the class to the wrapper element (controlled by `as`).
   * Portals that render outside the wrapper must use usePortalThemeClass().
   *
   * "none" — context-only mode. No theme class is written to the DOM at all.
   * Use when the host application's own provider is the sole DOM class writer
   * and you only need ThemeContext to be available inside the tree (e.g. when
   * embedding @gugu/session-ui components inside an app that manages themes itself).
   */
  target?: 'documentElement' | 'wrapper' | 'none';
  /** Element type for the wrapper (only used when target="wrapper" or className/style are supplied). Defaults to 'div'. */
  as?: React.ElementType;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

const ALL_THEME_CLASSES = THEME_MANIFEST.map((e) => e.selector.replace(/^\./, ''));

/**
 * @@@4259-theme-class-owners — `<html>` 的主题类是**共享状态**,这里按拥有者栈管理它。
 *
 * 这里从前是「进来清空所有主题类再写自己的,cleanup 再清空一次」。清空是 #4259 的触发器:
 * `<html>` 上那个类的**常驻拥有者是别人** —— 会话页自己的 ThemeProvider(它在 layout effect 里写
 * `emlight`/`emdark`,没有 cleanup,依赖只有 effectiveTheme,所以不会重跑)。而产品里有第二、第三个
 * documentElement 模式的 provider(建团队向导、对话页内建 Agent 的 composer)。它们一卸载就把
 * 常驻那位的类一起清掉,**没有人加回来**:只在那些类下定义的令牌于是全文档变成未定义,引用它们的
 * 规则静默落回初始值——不报错、不随交互恢复。表现就是「开关一次建团队向导,全局选中不再被画出来」。
 *
 * 换成拥有者栈,而不是「谁先卸载谁清空」:
 *   · 第一个拥有者进来时记下 `<html>` 原本带的类(常驻那位写的那个);
 *   · 任何时刻生效的都是**栈顶**拥有者的类;
 *   · 拥有者退出时,若还有别的拥有者,应用新的栈顶;都退完了才还原最初那份快照。
 * 这样卸载顺序不再重要(❌ 不依赖 LIFO),也永远不会在还有拥有者时把 `<html>` 留成空的。
 * 文件顶部那条「同一时刻只该有一个 documentElement provider」仍是更好的形状,但公共状态不该
 * 靠那条约定才不被弄坏。
 */
const documentElementOwners: { token: symbol; themeClass: string }[] = [];
let documentElementBaseline: string[] | null = null;

function applyTopOwnerThemeClass() {
  const root = document.documentElement;
  const top = documentElementOwners[documentElementOwners.length - 1];
  root.classList.remove(...ALL_THEME_CLASSES);
  if (top) root.classList.add(top.themeClass);
  else if (documentElementBaseline?.length) root.classList.add(...documentElementBaseline);
}

function claimDocumentElementTheme(themeClass: string): () => void {
  const root = document.documentElement;
  if (documentElementOwners.length === 0) {
    documentElementBaseline = ALL_THEME_CLASSES.filter((cls) => root.classList.contains(cls));
  }
  const token = Symbol('theme-owner');
  documentElementOwners.push({ token, themeClass });
  applyTopOwnerThemeClass();
  return () => {
    const index = documentElementOwners.findIndex((owner) => owner.token === token);
    if (index !== -1) documentElementOwners.splice(index, 1);
    applyTopOwnerThemeClass();
    if (documentElementOwners.length === 0) documentElementBaseline = null;
  };
}

/**
 * ThemeProvider — renders the theme class and provides ThemeContext.
 *
 * See module-level doc for target, CSS, and SSR notes.
 */
export function ThemeProvider({
  theme: controlledTheme,
  defaultTheme,
  target = 'documentElement',
  as: As = 'div',
  className,
  style,
  children,
}: ThemeProviderProps) {
  const initial: ThemeId =
    controlledTheme ?? defaultTheme ?? (THEME_MANIFEST[0]?.id as ThemeId) ?? 'light';
  const [themeId, setThemeId] = useState<ThemeId>(initial);

  // Sync internal state whenever the controlled prop changes.
  const prevControlled = React.useRef(controlledTheme);
  if (controlledTheme !== undefined && controlledTheme !== prevControlled.current) {
    prevControlled.current = controlledTheme;
    setThemeId(controlledTheme);
  }

  const resolvedThemeId = controlledTheme ?? themeId;

  const setTheme = useCallback((id: ThemeId) => {
    setThemeId(id);
  }, []);

  const toggle = useCallback(() => {
    setThemeId((current) => {
      const ids = THEME_MANIFEST.map((e) => e.id as ThemeId);
      const idx = ids.indexOf(current);
      return ids[(idx + 1) % ids.length] ?? ids[0]!;
    });
  }, []);

  const entry = THEME_MANIFEST.find((e) => e.id === resolvedThemeId) ?? THEME_MANIFEST[0]!;
  const themeClass = entry.selector.replace(/^\./, '');

  // Apply theme class to <html> in documentElement mode. See `documentElementOwners`.
  useLayoutEffect(() => {
    if (target !== 'documentElement') return;
    if (typeof document === 'undefined') return;
    return claimDocumentElementTheme(themeClass);
  }, [target, themeClass]);

  const ctx = useMemo<ThemeContextValue>(
    () => ({ themeId: resolvedThemeId, setTheme, toggle }),
    [resolvedThemeId, setTheme, toggle]
  );

  // In "none" mode: supply context without touching the DOM.
  if (target === 'none') {
    return <ThemeContext.Provider value={ctx}>{children}</ThemeContext.Provider>;
  }

  if (target === 'documentElement') {
    // No wrapper needed for theming. Render a wrapper only if className/style
    // were passed (e.g. for layout in Storybook).
    if (className !== undefined || style !== undefined) {
      return (
        <ThemeContext.Provider value={ctx}>
          <As className={className} style={style}>
            {children}
          </As>
        </ThemeContext.Provider>
      );
    }
    return <ThemeContext.Provider value={ctx}>{children}</ThemeContext.Provider>;
  }

  // wrapper mode: apply the theme class to the wrapper element.
  return (
    <ThemeContext.Provider value={ctx}>
      <As className={cx(themeClass, className)} style={style}>
        {children}
      </As>
    </ThemeContext.Provider>
  );
}
