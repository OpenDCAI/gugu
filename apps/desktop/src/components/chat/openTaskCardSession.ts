import type { TaskCard } from '@gugu/core/shared/ui/taskCardModels'
import { isScreenView } from '../../session/renderer/app/screen-layout-actions'
import { appState } from '../../session/renderer/lib/stores/app-state'
import { followLink } from '../../lib/guguLinks'

/** 任务卡打开它的任务:与其他入口同一条路;本机卡在屏幕视图上并排打开,保留当前布局(只有任务卡这样)。 */
export function openTaskCardSession(task: Pick<TaskCard, 'projectId' | 'sessionId'>, local = true): void {
  const beside = local && isScreenView(appState.navigation.currentViewId)
  followLink({ kind: 'session', sessionId: task.sessionId, ...(local ? { projectId: task.projectId } : {}), ...(beside ? { beside: true } : {}) })
}
