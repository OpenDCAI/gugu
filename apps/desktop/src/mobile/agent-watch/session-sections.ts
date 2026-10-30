import type {
  SessionpageProjectSummary,
  SessionpageSessionSummary,
} from '@gugu/session-core/session-record/contract'
import {
  buildSessionTree,
  familiesByRoot,
  foldIdleFamilies,
  pinnedSubtreeRoots,
  withoutPinnedSubtrees,
  type SessionTreeNode,
} from '@/session/renderer/features/sessions/session-tree'
import { assistantDescendants, isAssistantSession } from '@/session/renderer/features/assistant/assistant-lineage'
import { sidebarStateGroup } from '@/session/renderer/features/sidebar/session-groups'
import { sessionPresentation } from './watch-status'
import type { SessionDirectoryRow } from '@/session/shared/remote-sessions/session-directory'

export type SessionNode = SessionTreeNode<{
  id: string
  parentSessionId?: string | null
  isPinned?: boolean
  deviceId: string
  session: SessionpageSessionSummary
}>

/**
 * `pinned` = 顶部的「置顶」分区;`assistant` = 个人助理派出的那一组(组名是它,不按项目 / 机器分);
 * `project` 为 null 的另一格是「任务」:所有机器上不属于项目的会话(workspace 里的、项目没报上来的)平铺一张(#609)。
 * 其余是一台机器上的一个项目分区。`deviceId` = 项目分区所在的机器(其余几格不属于哪台机器,为 null)。
 * `key` = 这一格在本机折叠记录里的键;`folded` = 收进「展开显示」的闲置家族数(置顶分区不折,恒为 0);
 * `count` = 整格的会话数(含收起的),分区折起来时页头标它。
 */
export type SessionSection = {
  pinned: boolean
  assistant: boolean
  project: SessionpageProjectSummary | null
  deviceId: string | null
  key: string
  roots: SessionNode[]
  folded: number
  count: number
}

/** 页上列出的一台机器与它报上来的项目(次序 = 它们在页上的次序)。 */
export type SectionMachine = { deviceId: string; projects: readonly SessionpageProjectSummary[] }

export type SectionFold = {
  /** 点了「展开显示」的格(收起的闲置家族全露)。 */
  expanded: { has(key: string): boolean }
  online: (deviceId: string) => boolean
}

const PINNED_SECTION_KEY = '\u0000pinned'
export const ASSISTANT_SECTION_KEY = '\u0000assistant'
// 哨兵键用转义写法,❌ 把裸 NUL 字节敲进源码:git 会判整个文件是二进制。
export const TASKS_SECTION_KEY = '\u0000tasks'

/** 两台机器上可以有同名甚至同 id 的项目:格的键带机器,各是各的一格。 */
export function projectSectionKey(deviceId: string, projectId: string): string {
  return `${deviceId}|${projectId}`
}

/** #609 那台机器报上来的项目里真正是项目的(workspace 不成格,它的会话进「任务」)。 */
const projectsOf = (machine: SectionMachine): readonly SessionpageProjectSummary[] =>
  machine.projects.filter((project) => project.kind !== 'workspace')

const lastActive = (session: SessionpageSessionSummary): number =>
  (session.lastInteractedAt && Date.parse(session.lastInteractedAt)) || 0

const latestOf = (nodes: readonly SessionNode[]): number =>
  nodes.reduce((latest, node) => Math.max(latest, lastActive(node.item.session), latestOf(node.children)), 0)

/**
 * 归在个人助理那一组的会话:它派出的全部后代(沿父会话 / 由谁派的往下,assistant-lineage),
 * 加上住它那台云端宿主上的其余会话(那台不对人露出,它的项目名 / 机器名都不出现)。它自己那条不在内。
 */
export function assistantGroupIds(
  rows: readonly SessionDirectoryRow[],
  assistantId: string | null,
  homeIds: ReadonlySet<string>,
): Set<string> {
  const ids = new Set(assistantDescendants(rows.map(({ session }) => ({ summary: session })), assistantId).map((item) => item.summary.conversationId))
  for (const { deviceId, session } of rows) {
    if (homeIds.has(deviceId) && !isAssistantSession(session, assistantId)) ids.add(session.conversationId)
  }
  return ids
}

/**
 * 手机「项目」页的分区,与桌面侧栏同一种结构:
 *   · 顶部「置顶」收拢置顶的子树(最近动静在前,不分机器);
 *   · 个人助理派出的会话是**一组**(组名是它),❌ 再按项目 / 机器散进别的分区;它自己那条不列;
 *   · 其余每台机器的每个项目一格(机器是这一格的属性,不是上一层):最近有动静的在前;workspace 里的、项目行没回来的
 *     会话归最后那一格「任务」(所有机器平铺一张,#609),❌ 拿 projectId 当项目名冒充。
 * 树用所有机器的行一起建,一家子跟着根走(familiesByRoot,桌面同):画根所在的那一格,child 可以在别的项目、
 * 别的机器上(owner 2026-10-01 / 10-09)。项目分区按桌面同一条折法收起多出来的闲置家族(foldIdleFamilies),
 * 闲置的读法与桌面画别的机器的会话相同(sessionPresentation → sidebarStateGroup);`expanded` 里的格全露。
 * `rows` 要带**全部**机器的行(含不列出的云端宿主):助理那组的后代就在里面。
 */
export function sessionSections(
  machines: readonly SectionMachine[],
  rows: readonly SessionDirectoryRow[],
  assistant: { assistantId: string | null; homeIds: ReadonlySet<string> },
  fold: SectionFold,
): SessionSection[] {
  const group = assistantGroupIds(rows, assistant.assistantId, assistant.homeIds)
  const items = rows
    .filter(({ session }) => !isAssistantSession(session, assistant.assistantId))
    .sort((a, b) => lastActive(b.session) - lastActive(a.session))
    .map(({ deviceId, session }) => ({
      id: session.conversationId,
      parentSessionId: session.parentConversationId,
      isPinned: session.isPinned,
      deviceId,
      session,
    }))
  const known = new Map(machines.map((machine) => [machine.deviceId, new Set(projectsOf(machine).map((project) => project.id))]))
  // 助理那组的根与列出机器上的根才画;别的行(同一台电脑上旧实例的那条设备行)只作子会话出现,与从前一样。
  const roots = buildSessionTree(items).filter(({ item }) => group.has(item.id) || known.has(item.deviceId))
  const pinned = pinnedSubtreeRoots(roots)
  const cellOf = (root: SessionNode['item']): string =>
    group.has(root.id)
      ? ASSISTANT_SECTION_KEY
      : known.get(root.deviceId)?.has(root.session.projectId)
        ? projectSectionKey(root.deviceId, root.session.projectId)
        : TASKS_SECTION_KEY
  const families = familiesByRoot(withoutPinnedSubtrees(roots), cellOf)
  const isIdle = (item: SessionNode['item']): boolean =>
    sidebarStateGroup(sessionPresentation(item.session, fold.online(item.deviceId))) === null

  const cell = (
    key: string,
    base: Pick<SessionSection, 'assistant' | 'project' | 'deviceId'>,
  ): { section: SessionSection; latest: number } | null => {
    const family = families.get(key)
    if (!family) return null
    const { shown, folded } = foldIdleFamilies(family, isIdle, fold.expanded.has(key))
    return {
      section: { pinned: false, ...base, key, roots: shown, folded, count: countSessions(family) },
      latest: latestOf(family),
    }
  }
  type Cell = NonNullable<ReturnType<typeof cell>>
  const present = (list: (Cell | null)[]): Cell[] => list.filter((entry): entry is Cell => entry !== null)
  const projectCells = present(machines.flatMap((machine) =>
    projectsOf(machine).map((project) =>
      cell(projectSectionKey(machine.deviceId, project.id), { assistant: false, project, deviceId: machine.deviceId }))))
  const assistantCell = cell(ASSISTANT_SECTION_KEY, { assistant: true, project: null, deviceId: null })
  // 最近有动静的在前;同一刻的保持机器 / 宿主给的次序(Array.sort 稳定)。
  const ordered = present([...projectCells, assistantCell]).sort((a, b) => b.latest - a.latest)
  // 「任务」排最后,与桌面侧栏「项目」之后的「任务」同序;一格,❌ 按机器分。
  const tasks = present([cell(TASKS_SECTION_KEY, { assistant: false, project: null, deviceId: null })])

  const groups = [...ordered, ...tasks].map(({ section }) => section)
  pinned.sort((a, b) => lastActive(b.item.session) - lastActive(a.item.session))
  return pinned.length > 0
    ? [{ pinned: true, assistant: false, project: null, deviceId: null, key: PINNED_SECTION_KEY, roots: pinned, folded: 0, count: countSessions(pinned) }, ...groups]
    : groups
}

export function countSessions(nodes: readonly SessionNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countSessions(node.children), 0)
}

/**
 * 这条会话在哪一格、沿哪些父会话走到它(要把那些父会话点开它才露出来)。`sections` 要用**全露**的折法建
 * (`expanded` 全是 true),否则收进「展开显示」的行找不到。没有 = null。
 */
export function locateSession(
  sections: readonly SessionSection[],
  sessionId: string,
): { section: SessionSection; ancestors: string[] } | null {
  const walk = (nodes: readonly SessionNode[], path: string[]): string[] | null => {
    for (const node of nodes) {
      if (node.item.id === sessionId) return path
      const found = walk(node.children, [...path, node.item.id])
      if (found) return found
    }
    return null
  }
  for (const section of sections) {
    const ancestors = walk(section.roots, [])
    if (ancestors) return { section, ancestors }
  }
  return null
}
