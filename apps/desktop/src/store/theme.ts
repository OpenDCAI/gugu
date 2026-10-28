import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import React from 'react'
import {
  hydrateHostTheme,
  readEffectiveHostTheme,
  readThemePreference,
  startHostThemeSystemSync,
  subscribeToHostTheme,
  subscribeToThemePreference,
  writeThemePreference,
  type HostTheme,
  type ThemePreference,
} from '@renderer/lib/theme/host-theme'

/** 真值:当下到底是浅还是深。❌ 不含「跟随系统」——那是偏好,不是真值。 */
export type Theme = HostTheme

export type { ThemePreference }

interface ThemeContextValue {
  /** 当下的真值(解析过的)。要给 CSS/图标/编辑器挑明暗色阶的都读它。 */
  theme: Theme
  /** 用户在设置里选的那一项,含 `system` 和 `plain-white`。 */
  preference: ThemePreference
  setTheme: (preference: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'light',
  preference: 'light',
  setTheme: () => {},
})

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}

/**
 * 浅色 / 深色 / 跟随系统 / 素白。素白复用浅色真值,保留独立的偏好与表面样式。
 *
 * 这里不再自己存一份 state —— 偏好与真值的读写全在 `lib/theme/host-theme.ts` 那一处,
 * 本 provider 只是订阅者。会话页那个独立 React 根订阅的是同两条链,所以两边不会分家。
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(subscribeToHostTheme, readEffectiveHostTheme, () => 'light' as Theme)
  const preference = useSyncExternalStore(
    subscribeToThemePreference,
    readThemePreference,
    () => 'light' as ThemePreference,
  )

  // index.html 的引导脚本已经按同一套规则落过一次属性;这里补一次,兜住属性被别处清掉的情况。
  useEffect(() => {
    hydrateHostTheme()
  }, [])

  // 「跟随系统」的执行处。挂在这里 = 整个 app 生命周期内有效。
  useEffect(() => startHostThemeSystemSync(), [])

  const setTheme = (next: ThemePreference) => {
    writeThemePreference(next)
  }

  return React.createElement(
    ThemeContext.Provider,
    { value: { theme, preference, setTheme } },
    children,
  )
}
