import { useCallback } from 'react';
import type { SessionView } from '@shared/core/sessions/sessions';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { DEFAULT_SESSION_VIEW } from '@shared/core/sessions/new-session-defaults';

export { DEFAULT_SESSION_VIEW };

/**
 * 「新会话默认以哪一种展示开」的持久偏好:编程视角还是通用视角。存在应用设置 `newSessionMemory.sessionView`
 * (这台设备一份),主进程替 App 起会话(spawnAgent)时按同一份开(L11 复核 58:原先在 localStorage,主进程读不到)。
 */
export function useSessionViewPreference(): [SessionView, (next: SessionView) => void] {
  const { value, update } = useAppSettingsKey('newSessionMemory');
  const set = useCallback((next: SessionView) => update({ sessionView: next }), [update]);
  return [value?.sessionView ?? DEFAULT_SESSION_VIEW, set];
}
