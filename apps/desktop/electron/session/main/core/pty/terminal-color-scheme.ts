import { nativeTheme } from 'electron';
import { appSettingsService } from '@main/core/settings/settings-service';
import { log } from '@main/lib/logger';
import type { Theme } from '@shared/core/app-settings';

type EffectiveTheme = 'emlight' | 'emdark';

/**
 * COLORFGBG 编码的是**终端的**前景/背景(rxvt/konsole 约定,值是 ANSI 调色板下标),
 * 不是 App 主题:浅色终端 = `0;15`(黑字白底),深色终端 = `15;0`。
 */
const COLORFGBG_BY_SCHEME = {
  light: '0;15',
  dark: '15;0',
} as const;

export function resolveEffectiveTheme(theme: Theme, shouldUseDarkColors: boolean): EffectiveTheme {
  if (theme === 'emlight' || theme === 'emdark') return theme;
  return shouldUseDarkColors ? 'emdark' : 'emlight';
}

/**
 * 当前主题对应的 `{ COLORFGBG }`,给 pty 的 env 用。
 *
 * ⚠️ 这是**粗粒度的补充信号**,不是终端配色的真相:它只说得出明/暗两档,说不出
 * `--xterm-bg` 到底是哪个颜色,而且实测 codex 这类 TUI 根本不读它。真正决定 TUI 配色的是
 * 它自己发的 OSC 10/11 查询和 xterm.js 的回答(见 `@gugu/session-core/pty/node` 的
 * `CONPTY_SPAWN_OPTIONS`)。❌ 别再往这条路上加补偿。
 *
 * 出错返回 {},调用方可以直接展开。
 */
export async function getTerminalColorEnv(): Promise<Record<string, string>> {
  try {
    const appTheme = await appSettingsService.get('theme');
    const effective = resolveEffectiveTheme(appTheme, nativeTheme.shouldUseDarkColors);
    return {
      COLORFGBG: effective === 'emlight' ? COLORFGBG_BY_SCHEME.light : COLORFGBG_BY_SCHEME.dark,
    };
  } catch (error) {
    log.warn('terminal-color-scheme: failed to resolve app theme for COLORFGBG', {
      error: String(error),
    });
    return {};
  }
}
