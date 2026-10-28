import { runInAction, when } from 'mobx'
import { openLink } from '@/lib/guguLinks'
import { getProjectManagerStore } from '@/session/renderer/features/projects/stores/project-selectors'
import { workspaceBackend } from '@/session/renderer/features/sessions/workspace-backend/workspace-backend'
import type { WorkspaceViewModel } from '@/session/renderer/features/sessions/stores/workspace-view-model'
import { remoteHostsStore } from '@/session/renderer/features/remote-hosts/remote-hosts-store'
import { machineRegistry } from '@/session/renderer/lib/machine-routing'
import { browserUseTab } from './browserUseApp'

/**
 * Browser Use 的「浏览器」页签画的是哪台机器上的浏览器 —— 按页签所属的那个任务在哪台机器上跑:
 *   · local:这台电脑。agent 用的就是任务自带的「浏览器」页签,这里只指过去(❌ 再画一份)。
 *   · desktop:另一台咕咕桌面。它的浏览器在那台电脑上的任务里,这里看不到。
 *   · server:咕咕 server 上的 Chrome(cloudBrowser.*、实时画面、接管、保险箱)。
 *     `direct` = 这台电脑与它之间有直连的路(远程隧道 / SSH),实时画面与接管要它;没有就只看小图。
 * 读 mobx 的状态:在 observer 里调用。
 */
export type BrowserUseMachine =
  | { kind: 'local' }
  | { kind: 'desktop'; label: string }
  | { kind: 'server'; deviceId: string; label: string; online: boolean; direct: boolean }

/** 任务的工作区视图:按挂着的项目找(一个页签只知道它的任务,不知道项目;同 host-action-handlers 的找法)。 */
function sessionEntry(sessionId: string): { projectId: string; view: WorkspaceViewModel | undefined } | null {
  for (const [projectId, project] of getProjectManagerStore().projects) {
    const store = project.mountedProject?.sessionManager.sessions.get(sessionId)
    if (store) return { projectId, view: store.viewModel ?? undefined }
  }
  return null
}

export function browserUseMachine(sessionId: string): BrowserUseMachine {
  const entry = sessionEntry(sessionId)
  const machine = entry ? workspaceBackend(entry.projectId).machine : null
  // 任务还没挂上(冷启动先恢复了页签):按实体 id 认机器,认不出 = 本机。
  const deviceId = machine ? (machine.kind === 'remote' ? machine.deviceId : null) : machineRegistry.machineOf(sessionId)
  if (!deviceId) return { kind: 'local' }
  const device = remoteHostsStore.device(deviceId)
  const label = device?.label ?? deviceId
  if (device?.hostKind === 'desktop') return { kind: 'desktop', label }
  // 老宿主不报 hostKind:当 server 问,问不到再如实说(cloudBrowser.* 不支持 / 没有 Chrome)。
  return { kind: 'server', deviceId, label, online: device?.isOnline !== false, direct: device?.directTerminal !== false }
}

/** 这台电脑上的任务:亮出它已经开着的「浏览器」页签,没有就开一枚。 */
export function openTaskBrowser(sessionId: string): boolean {
  const view = sessionEntry(sessionId)?.view
  if (!view) return false
  runInAction(() => {
    for (const group of view.paneLayout.groups) {
      const tab = group.pane.resolvedTabs.find((candidate) => candidate.kind === 'browser')
      if (!tab) continue
      view.paneLayout.setActiveGroup(group.paneId)
      group.pane.setActiveTab(tab.tabId)
      return
    }
    view.paneLayout.open('browser', {}, { preview: false })
  })
  return true
}

const SESSION_VIEW_TIMEOUT_MS = 10_000

/**
 * 在那个任务里打开它的 Browser Use 页签(每任务一份):先到那个任务(会话页亮出来、任务挂上),
 * 再像页签条「+」那样开 App 的页签 —— 开在对话旁边。没装 / 停用了就抛,让入口照实说。
 */
export async function openBrowserUseTab(sessionId: string): Promise<void> {
  const { tab } = browserUseTab()
  if (!tab?.enabled) throw new Error('Browser Use is not available')
  await openLink({ kind: 'session', sessionId })
  try {
    await when(() => !!sessionEntry(sessionId)?.view, { timeout: SESSION_VIEW_TIMEOUT_MS })
  } catch {
    throw new Error('the task did not open on the session page')
  }
  const view = sessionEntry(sessionId)?.view
  if (!view) throw new Error('This task is no longer open')
  runInAction(() => view.paneLayout.open(tab.kind, {}, { preview: false, beside: true }))
}

