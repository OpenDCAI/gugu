import { describe, expect, it, vi } from 'vitest'
import { messageHost } from '../../../../apps/desktop/src/session/app-runtime/framed-host'
import { APP_FRAME_MARKER } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { hostEventHub, hostMembers } from '../../../../apps/desktop/src/session/shared/extensions/host-calls'

/**
 * Every host builds its members from one table (host-calls.ts): which members a caller has is its verb's `only` and what
 * that host answers. The member sets are the ones each host wrote by hand before the table — a page's, the background
 * page's, the phone frame's in a chat and in a session's tab, an App's program — so `typeof gugu.x` answers as it did.
 */
const names = (host: Record<string, unknown>) =>
  Object.entries(host).flatMap(([key, value]) =>
    value && typeof value === 'object' ? Object.keys(value).map((inner) => `${key}.${inner}`) : typeof value === 'function' ? [key] : []).sort()

const FILES = ['open', 'reopen', 'close', 'list', 'search', 'recent', 'create', 'remove', 'rename', 'mkdir', 'move', 'watch', 'replace', 'versions', 'readVersion', 'upload'].map((verb) => `appFiles.${verb}`)
const MESSAGES = ['messages.history', 'messages.search', 'chats.list', 'chats.members']
// L1 This computer's projects: the desktop's and an App's program's; a phone has none (no member).
const PROJECTS = ['projects.list']
// 论坛 (9): a page's, on the desktop and the phone alike; never a background page's or a program's.
const FORUM = ['list', 'read', 'post', 'reply', 'react', 'remove', 'block', 'assign', 'award', 'subscribe', 'unsubscribe'].map((verb) => `forum.${verb}`).concat('onForumChanged')
const EVERYONE = ['getContext', 'onContextChanged', 'onFilesChanged', 'getAppState', 'onAppStateChanged', 'onAgentsChanged', 'openBrowserTab', 'reportError', 'listAgents', 'readAgentHistory', 'spawnAgent', 'stopAgent', 'send', 'messageAgent', ...MESSAGES, ...PROJECTS, 'readData', 'writeData', 'listData', 'callProgram', 'onProgramNotification', 'notify', 'onNotificationClicked', 'linkTo', 'onLink', ...FILES]
const MODAL = ['modal.open', 'modal.close', 'modal.key', 'onModalClosed', 'onModalFocus']
const PAGE_ONLY = [...MODAL, ...FORUM, 'onCommand', 'setTabTitle', 'setTabBadge', 'sendToBackground', 'onBackgroundMessage', 'compose', 'showMessage', 'showSession', 'clipboard.writeText', 'appFiles.openWith', 'appFiles.download']
const PHONE = [...MODAL, 'getContext', 'onContextChanged', 'onFilesChanged', 'reportError', 'openBrowserTab', 'send', ...MESSAGES, ...FORUM, 'setTabTitle', 'setTabBadge', 'onCommand', 'onLink', 'showMessage', 'showSession', 'compose', 'clipboard.writeText', 'readData', 'writeData', 'listData', ...FILES, 'appFiles.openWith', 'appFiles.download']

const desktop = (caller: 'page' | 'background') => hostMembers(caller, () => true, vi.fn(), hostEventHub().on)
const overMessages = (flags: { framed?: true; program?: true; session?: true }) => messageHost({ post: vi.fn(), listen: () => undefined }, flags) as Record<string, unknown>

describe('one table, the members each host had', () => {
  it('the desktop: a page has every verb but the background\'s; the background page, every verb but a page\'s', () => {
    expect(names(desktop('page'))).toEqual([...EVERYONE, ...PAGE_ONLY].sort())
    expect(names(desktop('background'))).toEqual([...EVERYONE, 'broadcastToViews', 'onViewMessage'].sort())
  })

  it('the phone: what its host answers — the program only in a session\'s tab; an App\'s program: its files and messages', () => {
    expect(names(overMessages({ framed: true }))).toEqual([...PHONE].sort())
    expect(names(overMessages({ framed: true, session: true }))).toEqual([...PHONE, 'callProgram', 'onProgramNotification'].sort())
    expect(names(overMessages({ program: true }))).toEqual(['getContext', 'onContextChanged', 'onFilesChanged', 'reportError', 'openBrowserTab', 'send', 'messageAgent', ...MESSAGES, ...PROJECTS, ...FILES].sort())
  })

  it('a member asks its verb with its arguments packed one way, on every host', () => {
    const posted: unknown[] = []
    const host = messageHost({ post: (message) => posted.push(message), listen: () => undefined }, { framed: true, session: true }) as Record<string, (...args: unknown[]) => unknown> & { appFiles: Record<string, (args: unknown) => unknown> }
    void host.callProgram('graph', { a: 1 })
    void host.reportError('oops', { level: 'hint' })
    void host.appFiles.upload({ place: { chat: 'c' } })
    const call = vi.fn(async () => undefined)
    const page = hostMembers('page', () => true, call, hostEventHub().on) as Record<string, (...args: unknown[]) => unknown> & { appFiles: Record<string, (args: unknown) => unknown> }
    void page.callProgram('graph', { a: 1 })
    void page.reportError('oops', { level: 'hint' })
    void page.appFiles.upload({ place: { chat: 'c' } })
    const sent = posted.map((message) => [(message as { method: string }).method, (message as { args: unknown }).args])
    expect(sent).toEqual([
      ['callProgram', { name: 'graph', arguments: { a: 1 } }],
      ['reportError', { message: 'oops', level: 'hint' }],
      ['filesUpload', { place: { chat: 'c' }, pick: true, sourceMessageIds: undefined }],
    ])
    expect(call.mock.calls).toEqual(sent)
  })

  it('a link that came before the page subscribed is held for its first subscriber — on either transport', () => {
    let deliver: (message: unknown) => void = () => undefined
    const host = messageHost({ post: vi.fn(), listen: (handler) => (deliver = handler) }, { framed: true }) as Record<string, (fn: (value: unknown) => void) => () => void>
    deliver({ m: APP_FRAME_MARKER, t: 'event', event: { type: 'link', tab: 'main', path: '', query: {}, file: null } })
    const heard: unknown[] = []
    host.onLink!((value) => heard.push(value))
    expect(heard).toEqual([{ tab: 'main', path: '', query: {}, file: null }])
  })
})
