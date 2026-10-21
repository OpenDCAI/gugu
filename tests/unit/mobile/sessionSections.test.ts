import { describe, expect, it } from 'vitest'
import type {
  SessionpageProjectSummary,
  SessionpageSessionSummary,
} from '@gugu/session-core/session-record/contract'
import {
  ASSISTANT_SECTION_KEY,
  assistantGroupIds,
  countSessions,
  locateSession,
  projectSectionKey,
  sessionSections as sectionsOf,
  type SessionNode,
} from '../../../apps/desktop/src/mobile/agent-watch/session-sections'

/** 拆成「置顶分区的树」与「项目分区」两半,并核置顶分区只会出现在第一位。默认全在一台机器上。 */
const split = (sections: ReturnType<typeof sectionsOf>) => {
  expect(sections.slice(1).some((s) => s.pinned)).toBe(false)
  return {
    pinned: sections[0]?.pinned ? sections[0].roots : [],
    groups: sections.filter((s) => !s.pinned),
  }
}
const NO_FOLD = { expanded: new Set<string>(), online: () => true }
const NO_ASSISTANT = { assistantId: null, homeIds: new Set<string>() }
const sessionSections = (projects: SessionpageProjectSummary[], sessions: SessionpageSessionSummary[]) =>
  split(sectionsOf([{ deviceId: 'd1', projects }], sessions.map((s) => ({ deviceId: 'd1', session: s })), NO_ASSISTANT, NO_FOLD))

const project = (id: string): SessionpageProjectSummary => ({ id, name: id.toUpperCase(), path: `/${id}` })
const session = (
  sessionId: string,
  projectId: string,
  minute: number,
  extra: Partial<SessionpageSessionSummary> = {},
): SessionpageSessionSummary => ({
  conversationId: sessionId,
  projectId,
  title: sessionId,
  harness: 'codex',
  runtime: 'acp',
  agentStatus: null,
  lastInteractedAt: `2026-09-27T10:${String(minute).padStart(2, '0')}:00.000Z`,
  supported: true,
  ...extra,
})

/** 一棵树画成 `id(child,child)`,次序即画面上的次序。 */
const shape = (nodes: readonly SessionNode[]): string =>
  nodes.map((n) => (n.children.length ? `${n.item.id}(${shape(n.children)})` : n.item.id)).join(',')

describe('sessionSections — 手机会话页与桌面侧栏同一种结构', () => {
  it('置顶的子树整棵离开项目、进「置顶」分区;子会话挂在父会话下', () => {
    const { pinned, groups } = sessionSections(
      [project('a')],
      [
        session('parent', 'a', 1, { isPinned: true }),
        session('child', 'a', 2, { parentConversationId: 'parent' }),
        session('plain', 'a', 3),
        session('kid', 'a', 4, { parentConversationId: 'plain' }),
      ],
    )
    expect(shape(pinned)).toBe('parent(child)')
    expect(groups.map((g) => [g.project?.id, shape(g.roots)])).toEqual([['a', 'plain(kid)']])
  })

  it('置顶的子会话离开未置顶的父会话,单独进「置顶」分区', () => {
    const { pinned, groups } = sessionSections(
      [project('a')],
      [session('parent', 'a', 1), session('child', 'a', 2, { parentConversationId: 'parent', isPinned: true })],
    )
    expect(shape(pinned)).toBe('child')
    expect(shape(groups[0].roots)).toBe('parent')
  })

  it('跨项目收拢置顶,最近动静在前;项目里的会话也是最近动静在前', () => {
    const { pinned, groups } = sessionSections(
      [project('a'), project('b')],
      [
        session('a-old', 'a', 1, { isPinned: true }),
        session('b-new', 'b', 9, { isPinned: true }),
        session('a1', 'a', 2),
        session('a2', 'a', 5),
      ],
    )
    expect(shape(pinned)).toBe('b-new,a-old')
    expect(shape(groups[0].roots)).toBe('a2,a1')
  })

  it('项目分区最近有动静的在前;全被置顶走的项目不留空分区;项目行没回来的归「未归入项目」排最后', () => {
    const { groups } = sessionSections(
      [project('a'), project('b'), project('c')],
      [
        session('orphan', 'gone', 9),
        session('c1', 'c', 8),
        session('b1', 'b', 7, { isPinned: true }),
        session('a1', 'a', 1),
      ],
    )
    expect(groups.map((g) => g.project?.id ?? null)).toEqual(['c', 'a', null])
  })

  it('老宿主不报 isPinned / parentConversationId:不画置顶、不缩进(中性态,❌ 补默认值)', () => {
    const { pinned, groups } = sessionSections(
      [project('a')],
      [session('s1', 'a', 1), session('s2', 'a', 2)],
    )
    expect(pinned).toEqual([])
    expect(shape(groups[0].roots)).toBe('s2,s1')
  })

  // owner 2026-10-02:选了 nest 的 child 可以在别的项目里 —— 一家子跟着根会话的项目走(桌面侧栏同一条)。
  it('别的项目里的 child 挂在父会话下、在父会话的项目分区里,自己的项目分区不再列它', () => {
    const { groups } = sessionSections(
      [project('a'), project('b')],
      [
        session('parent', 'a', 1),
        session('child', 'b', 2, { parentConversationId: 'parent' }),
        session('b-own', 'b', 3),
      ],
    )
    // 分区按最近动静排:b 里最新一条(b-own,3)比 a 家族(2)新。
    expect(groups.map((g) => [g.project?.id, shape(g.roots)])).toEqual([['b', 'b-own'], ['a', 'parent(child)']])
  })

  // owner 2026-10-09:进 Chole 看得到 125,看不到它下面在 ThinkPad 上的子会话。树用所有机器的行一起建;
  // 「项目」页(#7199)把所有机器摆在同一页:child 跟着父会话画在父会话那台机器的项目分区里,不再当第二份根。
  it('别的机器上的 child 挂在父会话下、画在父会话的项目分区里,行上带它自己的机器;它那台机器的分区不再把它当根', () => {
    const rows = [
      { deviceId: 'chole', session: session('125', 'a', 1) },
      { deviceId: 'thinkpad', session: session('lane', 't', 2, { parentConversationId: '125' }) },
      { deviceId: 'thinkpad', session: session('grand', 't', 3, { parentConversationId: 'lane' }) },
      { deviceId: 'thinkpad', session: session('tp-own', 't', 4) },
    ]
    const machines = [
      { deviceId: 'chole', projects: [project('a')] },
      { deviceId: 'thinkpad', projects: [project('t')] },
    ]
    const all = split(sectionsOf(machines, rows, NO_ASSISTANT, NO_FOLD))
    expect(all.groups.map((g) => [g.deviceId, g.project?.id, shape(g.roots)])).toEqual([
      ['thinkpad', 't', 'tp-own'],
      ['chole', 'a', '125(lane(grand))'],
    ])
    const chole = all.groups.find((g) => g.deviceId === 'chole')!
    expect(chole.roots[0].children[0].item.deviceId).toBe('thinkpad')
  })

  it('countSessions 数整棵树', () => {
    const { pinned } = sessionSections(
      [project('a')],
      [
        session('p', 'a', 1, { isPinned: true }),
        session('c', 'a', 2, { parentConversationId: 'p' }),
        session('g', 'a', 3, { parentConversationId: 'c' }),
      ],
    )
    expect(countSessions(pinned)).toBe(3)
  })
})

// 「展开显示」与桌面侧栏同一条折法(foldIdleFamilies):按家族折,不闲置的家族永远露着,置顶分区不折。
describe('sessionSections — 项目分区的「展开显示」', () => {
  const rowsOf = (sessions: SessionpageSessionSummary[]) => sessions.map((s) => ({ deviceId: 'd1', session: s }))
  const keyA = projectSectionKey('d1', 'a')
  const keyUngrouped = projectSectionKey('d1', null)
  // 7 个闲置的根(r1 最新),r1 带一个孩子;还有一个更早的根,它的孩子在跑。
  const sessions = [
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => session(`r${n}`, 'a', 50 - n)),
    session('kid', 'a', 48, { parentConversationId: 'r1' }),
    session('busy-root', 'a', 10),
    session('busy-kid', 'a', 9, { parentConversationId: 'busy-root', agentStatus: 'working' }),
    session('loose', 'gone', 5),
    session('pin', 'a', 1, { isPinned: true }),
  ]
  const fold = (expanded: string[], online = true) =>
    split(sectionsOf([{ deviceId: 'd1', projects: [project('a')] }], rowsOf(sessions), NO_ASSISTANT, { expanded: new Set(expanded), online: () => online }))

  it('闲置家族只露前 5 个,整家不拆;在跑的家族露着、不占名额;置顶分区不折;分区计数含收起的', () => {
    const { pinned, groups } = fold([])
    expect(groups.map((g) => [g.key, shape(g.roots), g.folded, g.count])).toEqual([
      [keyA, 'r1(kid),r2,r3,r4,r5,busy-root(busy-kid)', 2, 10],
      [keyUngrouped, 'loose', 0, 1],
    ])
    expect(shape(pinned)).toBe('pin')
  })

  it('点开的分区全露,收起的家族数不变', () => {
    const { groups } = fold([keyA])
    expect(groups.map((g) => [g.key, shape(g.roots), g.folded])[0]).toEqual([
      keyA, 'r1(kid),r2,r3,r4,r5,r6,r7,busy-root(busy-kid)', 2,
    ])
  })

  it('机器离线时「在跑」不算数(与桌面画别的机器同一口径):那一家按闲置折', () => {
    const { groups } = fold([], false)
    expect(shape(groups[0].roots)).toBe('r1(kid),r2,r3,r4,r5')
    expect(groups[0].folded).toBe(3)
  })
})

// #7199 「项目」页:所有机器一页,机器是项目分区的属性;个人助理派出的会话是一组(组名是它)。
describe('sessionSections — 多台机器与个人助理那一组', () => {
  const rowsOn = (deviceId: string, sessions: SessionpageSessionSummary[]) => sessions.map((s) => ({ deviceId, session: s }))
  const ASSISTANT = 'assistant-agent'
  const own = (id: string, minute: number, extra: Partial<SessionpageSessionSummary> = {}) =>
    session(id, 'home-p', minute, { agent: { userId: ASSISTANT }, ...extra })
  const withAssistant = { assistantId: ASSISTANT, homeIds: new Set(['home']) }
  const mac = { deviceId: 'mac', projects: [project('p')] }
  const thinkpad = { deviceId: 'thinkpad', projects: [project('p')] }

  it('两台机器上同名(同 id)的项目是各自的一格,页头带各自的机器,不并成一格', () => {
    const sections = sectionsOf(
      [mac, thinkpad],
      [...rowsOn('mac', [session('m1', 'p', 1)]), ...rowsOn('thinkpad', [session('t1', 'p', 2), session('t2', 'p', 3)])],
      NO_ASSISTANT,
      NO_FOLD,
    )
    expect(sections.map((s) => [s.deviceId, s.project?.name, shape(s.roots)])).toEqual([
      ['thinkpad', 'P', 't2,t1'],
      ['mac', 'P', 'm1'],
    ])
    expect(new Set(sections.map((s) => s.key)).size).toBe(2)
  })

  it('一台机器没有任何会话就没有分区(选机器页仍列它,这一页不画空壳)', () => {
    const sections = sectionsOf([mac, thinkpad], rowsOn('mac', [session('m1', 'p', 1)]), NO_ASSISTANT, NO_FOLD)
    expect(sections.map((s) => s.deviceId)).toEqual(['mac'])
  })

  it('个人助理派出的会话(含孙辈、含别的机器上的)收成一组,不再列在自己的项目下;它自己那条不列', () => {
    const rows = [
      ...rowsOn('home', [own('assistant-own', 1), session('on-home', 'home-p', 2, { parentConversationId: 'assistant-own' })]),
      ...rowsOn('mac', [
        session('dispatched', 'p', 3, { spawnedByConversationId: 'assistant-own' }),
        session('grand', 'p', 4, { parentConversationId: 'dispatched' }),
        session('mine', 'p', 5),
      ]),
      ...rowsOn('thinkpad', [session('remote', 'p', 6, { parentConversationId: 'assistant-own' })]),
    ]
    const sections = sectionsOf([mac, thinkpad], rows, withAssistant, NO_FOLD)
    const group = sections.filter((s) => s.assistant)
    expect(group).toHaveLength(1)
    expect(group[0].key).toBe(ASSISTANT_SECTION_KEY)
    expect(group[0].deviceId).toBeNull()
    expect(group[0].project).toBeNull()
    expect(shape(group[0].roots)).toBe('remote,dispatched(grand),on-home')
    const projectSections = sections.filter((s) => !s.assistant)
    expect(projectSections.map((s) => [s.deviceId, shape(s.roots)])).toEqual([['mac', 'mine']])
    const ids = (nodes: readonly SessionNode[]): string[] => nodes.flatMap((n) => [n.item.id, ...ids(n.children)])
    expect(sections.flatMap((s) => ids(s.roots))).not.toContain('assistant-own')
  })

  it('云端宿主上的会话进助理那一组,它的项目不单列(宿主不在列出的机器里)', () => {
    const rows = rowsOn('home', [session('h1', 'home-p', 1), session('h2', 'other-project', 2)])
    const sections = sectionsOf([mac], rows, withAssistant, NO_FOLD)
    expect(sections.map((s) => [s.assistant, s.deviceId, s.project, shape(s.roots)])).toEqual([[true, null, null, 'h2,h1']])
    expect([...assistantGroupIds(rows, ASSISTANT, new Set(['home']))].sort()).toEqual(['h1', 'h2'])
    // 阴控:不知道哪台是宿主时这些行没有格可进(不会冒充成某个项目)。
    expect(sectionsOf([mac], rows, NO_ASSISTANT, NO_FOLD)).toEqual([])
  })

  it('置顶跨机器收拢成一格排最前;被置顶的助理后代只在置顶里出现一次', () => {
    const rows = [
      ...rowsOn('mac', [session('m-pinned', 'p', 1, { isPinned: true }), session('m1', 'p', 5)]),
      ...rowsOn('thinkpad', [session('t-pinned', 'p', 2, { isPinned: true })]),
      ...rowsOn('home', [own('assistant-own', 1)]),
      ...rowsOn('mac', [session('kid-pinned', 'p', 3, { spawnedByConversationId: 'assistant-own', isPinned: true })]),
    ]
    const sections = sectionsOf([mac, thinkpad], rows, withAssistant, NO_FOLD)
    expect(sections[0].pinned).toBe(true)
    expect(sections.slice(1).some((s) => s.pinned)).toBe(false)
    expect(shape(sections[0].roots)).toBe('kid-pinned,t-pinned,m-pinned')
    expect(sections.some((s) => s.assistant)).toBe(false)
    expect(sections.filter((s) => s.roots.some((r) => r.item.id === 'kid-pinned'))).toHaveLength(1)
  })

  it('分区按最近动静排,助理那一组与项目分区一起比;「未归入项目」按机器次序排在所有项目分区之后', () => {
    const rows = [
      ...rowsOn('mac', [session('m-old', 'p', 1), session('m-loose', 'gone', 20)]),
      ...rowsOn('thinkpad', [session('t-mid', 'p', 5), session('t-loose', 'gone', 30)]),
      ...rowsOn('home', [own('assistant-own', 1)]),
      ...rowsOn('mac', [session('dispatched', 'p', 9, { spawnedByConversationId: 'assistant-own' })]),
    ]
    const sections = sectionsOf([mac, thinkpad], rows, withAssistant, NO_FOLD)
    expect(sections.map((s) => (s.assistant ? 'assistant' : `${s.deviceId}:${s.project?.id ?? 'ungrouped'}`))).toEqual([
      'assistant',
      'thinkpad:p',
      'mac:p',
      'mac:ungrouped',
      'thinkpad:ungrouped',
    ])
  })

  it('locateSession:全露的折法下找到收起行与沿途的父会话', () => {
    const sessions = [
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => session(`r${n}`, 'p', 50 - n)),
      session('deep', 'p', 1, { parentConversationId: 'r7' }),
    ]
    const machines = [mac]
    const rows = rowsOn('mac', sessions)
    const folded = sectionsOf(machines, rows, NO_ASSISTANT, NO_FOLD)
    expect(locateSession(folded, 'deep')).toBeNull()
    const open = sectionsOf(machines, rows, NO_ASSISTANT, { expanded: { has: () => true }, online: () => true })
    const found = locateSession(open, 'deep')
    expect(found?.section.key).toBe(projectSectionKey('mac', 'p'))
    expect(found?.ancestors).toEqual(['r7'])
  })
})
