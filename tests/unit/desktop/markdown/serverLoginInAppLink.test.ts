// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serverLoginCode, type GuguLinkTarget } from '@gugu/core/shared/ui/guguLink'
import { openLinkWith } from '../../../../apps/desktop/src/session/shared/extensions/open-link'
import { useLinkNavigation } from '../../../../apps/desktop/src/hooks/useLinkNavigation'
import { openLink, openLinkTarget } from '../../../../apps/desktop/src/lib/guguLinks'

vi.mock('@gugu/core/cloud/config', () => ({ getSupabaseUrl: () => 'https://devdb.example.test', getSupabaseAnonKey: () => 'anon' }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'web' } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getMessageById: vi.fn() } }))
// Only the phone transport is replaced: the codec, opening algorithm and shell receiver are real.
vi.mock('../../../../apps/desktop/src/components/appSlot/phoneAppHost', () => ({
  openPhoneLink: (target: GuguLinkTarget) => openLinkWith({
    installed: () => [], isEnabled: () => false, locale: () => 'en', sessionProject: async () => null,
    reveal: async () => {}, openApp: async () => 'own', resourceChat: async (id) => id,
    openResource: async (resource) => { await openLinkTarget(resource) }, deliver: () => {},
  }, target),
}))

import {
  SERVER_LOGIN_APPROVE_EVENT,
  type ServerLoginApproveDetail,
} from '../../../../apps/desktop/src/lib/inAppLinks'

/**
 * `gugu-server login` 打出的确认链接在手机上直接进 App 批准。聊天里点的与系统交给 App 的(appUrlOpen)
 * 走同一个 openLink:认出本库的 server-login 链接、且有页面接(手机壳)才在 App 里开,否则照旧去浏览器。
 */

const LINK = 'https://devdb.example.test/functions/v1/server-login?code=ABCD-EFGH'

describe('serverLoginCode', () => {
  it('本库的确认链接 → 短码', () => {
    expect(serverLoginCode(LINK, 'https://devdb.example.test')).toBe('ABCD-EFGH')
    expect(serverLoginCode('https://devdb.example.test/functions/v1/server-login/?code=abcd-efgh', 'https://devdb.example.test/')).toBe('abcd-efgh')
  })

  it('没带短码 → 空串(仍是确认页链接,批准页照实说找不到)', () => {
    expect(serverLoginCode('https://devdb.example.test/functions/v1/server-login', 'https://devdb.example.test')).toBe('')
  })

  it('别的库、别的路径、不是地址 → 不认', () => {
    expect(serverLoginCode('https://db.example.test/functions/v1/server-login?code=ABCD-EFGH', 'https://devdb.example.test')).toBeNull()
    expect(serverLoginCode('https://devdb.example.test/functions/v1/server-login/poll?code=ABCD-EFGH', 'https://devdb.example.test')).toBeNull()
    expect(serverLoginCode('http://devdb.example.test/functions/v1/server-login?code=ABCD-EFGH', 'https://devdb.example.test')).toBeNull()
    expect(serverLoginCode('not a url', 'https://devdb.example.test')).toBeNull()
  })
})

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const noop = () => undefined
function Shell() {
  useLinkNavigation({ ownerId: 'owner', chats: [], contacts: [], openChat: noop, openFile: noop, openApp: noop, openProject: noop, openOwnApp: noop, openAssistant: noop })
  return null
}

describe('server login uses the common parser, opener and shell', () => {
  const seen: string[] = []
  const take = (event: Event) => {
    seen.push((event as CustomEvent<ServerLoginApproveDetail>).detail.code)
    event.preventDefault()
  }
  let root: Root, container: HTMLDivElement, width: number
  beforeEach(async () => {
    width = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root.render(createElement(Shell)))
  })
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove()
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
    window.removeEventListener(SERVER_LOGIN_APPROVE_EVENT, take)
    seen.length = 0
  })

  it('leaves the HTTPS login page to the browser in the desktop shell', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    expect(openLink(LINK)).toBeNull()
  })

  it('hands the same target to the mobile approval page from a click or system URL', async () => {
    window.addEventListener(SERVER_LOGIN_APPROVE_EVENT, take)
    await expect(openLink(LINK)).resolves.toBe(true)
    await expect(openLink(LINK)).resolves.toBe(true)
    expect(seen).toEqual(['ABCD-EFGH', 'ABCD-EFGH'])
  })

  it('returns a failure when this mobile shell has no approval page', async () => {
    await expect(openLink(LINK)).rejects.toThrow('links.unavailable')
  })

  it('leaves other web pages alone', () => {
    window.addEventListener(SERVER_LOGIN_APPROVE_EVENT, take)
    expect(openLink('https://example.com/x')).toBeNull()
    expect(seen).toEqual([])
  })
})
