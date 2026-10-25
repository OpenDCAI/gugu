import type { TaskCard } from '@gugu/core/shared/ui/taskCardModels'
import { isScreenView, showSessionBeside } from '../../session/renderer/app/screen-layout-actions'
import { openSessionInSessionWhenReady } from '../../session/renderer/features/sessions/open-session-in-session'
import { appState } from '../../session/renderer/lib/stores/app-state'
import { openSessionInFull } from '../appSlot/peekFullSession'
import { followLink } from '../../lib/guguLinks'

/** 本机卡保留当前布局;另一台机器的任务按统一资源入口从自己的任务目录打开。 */
export function openTaskCardSession(task: Pick<TaskCard, 'projectId' | 'sessionId'>, local = true): void {
  if (!local) {
    followLink({ kind: 'session', sessionId: task.sessionId })
    return
  }
  const target = { projectId: task.projectId, sessionId: task.sessionId }
  if (isScreenView(appState.navigation.currentViewId)) {
    showSessionBeside(target)
    openSessionInSessionWhenReady(target)
    return
  }
  openSessionInFull(target)
}
