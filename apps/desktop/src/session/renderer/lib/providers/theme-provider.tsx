import { useEffect, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';
import { applyThemeToAll } from '@renderer/lib/pty/pty';
import {
  nextHostTheme,
  readHostTheme,
  readThemePreference,
  startHostThemeSystemSync,
  subscribeToHostTheme,
  subscribeToThemePreference,
  writeHostTheme,
  writeThemePreference,
  type EffectiveTheme,
  type ThemePreference,
} from '@renderer/lib/theme/host-theme';
import type { Theme } from '@shared/core/app-settings';
import { ThemeContext } from './theme-context';

/**
 * 会话页自身的 CSS(session-ui 的 theme registry、chat-ui 的 theme.css.ts、代码高亮器)按
 * `.emlight` / `.emdark` 取色阶,所以根上仍要打这个类 —— 但它现在是咕咕主题的投影,不是
 * 另一份独立状态。真值与理由见 `lib/theme/host-theme.ts`。
 */
function applyTheme(effective: EffectiveTheme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.remove('emlight', 'emdark');
  root.classList.add(effective);
}



export function ThemeProvider({ children }: { children: ReactNode }) {
  const effectiveTheme = useSyncExternalStore(subscribeToHostTheme, readHostTheme, readHostTheme);
  const preference = useSyncExternalStore(
    subscribeToThemePreference,
    readThemePreference,
    readThemePreference,
  );

  useLayoutEffect(() => {
    applyTheme(effectiveTheme);
  }, [effectiveTheme]);

  // Re-apply xterm theme after CSS classes have been updated by the layout effect above.
  useEffect(() => {
    applyThemeToAll();
  }, [effectiveTheme]);

  // @@@5293 会话页可以自己开着(独立 React 根),所以它也要认领一份「跟随系统」的同步;
  // host-theme 里按引用计数做成幂等,与咕咕那份不会重复挂监听。
  useEffect(() => startHostThemeSystemSync(), []);

  // 真值仍是二态 —— 第三态在**偏好**那一层,不在这里。
  const setTheme = (next: Theme) => {
    if (next) writeHostTheme(next);
  };

  const setPreference = (next: ThemePreference) => {
    writeThemePreference(next);
  };

  const toggleTheme = () => {
    writeHostTheme(nextHostTheme(effectiveTheme));
  };

  return (
    <ThemeContext.Provider
      value={{ theme: effectiveTheme, setTheme, toggleTheme, effectiveTheme, preference, setPreference }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
