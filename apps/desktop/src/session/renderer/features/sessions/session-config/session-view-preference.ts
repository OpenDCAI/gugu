import type { SessionView } from '@shared/core/sessions/sessions';
import { useTerminalEnabled } from '@renderer/features/settings/use-terminal-enabled';
import { DEFAULT_SESSION_VIEW } from '@shared/core/sessions/new-session-defaults';

export { DEFAULT_SESSION_VIEW };

/**
 * 新会话默认以哪一种展示开。不再由人在新建框里选(「通用 / 编程」切换已删):跟本机的「终端」开关走,
 * 开着 → 编程,关着 → 通用。主进程替 App 起会话(spawnAgent)、手机建任务按同一份开(terminal-visibility.ts)。
 */
export function useSessionViewPreference(): SessionView {
  return useTerminalEnabled() ? 'code' : 'general';
}
