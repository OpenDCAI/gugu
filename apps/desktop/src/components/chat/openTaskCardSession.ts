import type { TaskCard } from '@gugu/core/shared/ui/taskCardModels'
import { isScreenView, showSessionBeside } from '../../session/renderer/app/screen-layout-actions'
import { openSessionInSessionWhenReady } from '../../session/renderer/features/sessions/open-session-in-session'
import { appState } from '../../session/renderer/lib/stores/app-state'
import { openSessionInFull } from '../appSlot/peekFullSession'

/** 点卡 = 在这一屏上(会话、项目、对话块)就拼在正看着那块右边(与侧栏 ⌘ 点同一条);在聊天页就整页打开它。 */
export function openTaskCardSession(task: Pick<TaskCard, 'projectId' | 'sessionId'>): void {
  const target = { projectId: task.projectId, sessionId: task.sessionId }
  if (isScreenView(appState.navigation.currentViewId)) {
    showSessionBeside(target)
    openSessionInSessionWhenReady(target)
    return
  }
  openSessionInFull(target)
}
