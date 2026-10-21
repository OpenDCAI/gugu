// 会话页主题的 Context **单独一个文件**,且只依赖 react 与类型。
//
// ⚠️ 别把它挪回 theme-provider.tsx:那个文件 import 了终端(pty)一大串模块,开发版里其中任何一个被改,
// 热更新就会让 theme-provider.tsx 重新执行 → `createContext` 造出一个**新的** Context 对象;
// 已挂着的 Provider 还拿着旧的,重新执行过的 useTheme 读新的 ⇒ 读到 undefined,整页落到
// 「useTheme must be used within a ThemeProvider」(#6264 实测:改 remote-create-source.tsx 必现)。
// 放在这里,这个文件永远不会被连带失效,Context 的身份跨热更新保持不变。
import { createContext } from 'react';
import type { EffectiveTheme, ThemePreference } from '@renderer/lib/theme/host-theme';
import type { Theme } from '@shared/core/app-settings';

export interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  effectiveTheme: EffectiveTheme;
  /** @@@5293 用户在设置里选的那一项,含「跟随系统」。只有设置界面画选中态需要它。 */
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);
