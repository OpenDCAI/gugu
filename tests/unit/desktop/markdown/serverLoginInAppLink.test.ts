// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@gugu/core/cloud/config', () => ({ getSupabaseUrl: () => 'https://devdb.example.test', getSupabaseAnonKey: () => 'anon' }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { from: () => { throw new Error('not a file link') } } }))

import { chatLinks } from '../../../../apps/desktop/src/components/markdown/fileLinks'
import {
  openAppLink,
  SERVER_LOGIN_APPROVE_EVENT,
  serverLoginCode,
  type ServerLoginApproveDetail,
} from '../../../../apps/desktop/src/lib/inAppLinks'

/**
 * `gugu-server login` 打出的确认链接在手机上直接进 App 批准。聊天里点的(chatLinks)与系统交给 App 的(appUrlOpen)
 * 走同一个 openAppLink:认出本库的 server-login 链接、且有页面接(手机壳)才在 App 里开,否则照旧去浏览器。
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

describe('openAppLink / chatLinks', () => {
  const seen: string[] = []
  const take = (event: Event) => {
    seen.push((event as CustomEvent<ServerLoginApproveDetail>).detail.code)
    event.preventDefault()
  }
  afterEach(() => {
    window.removeEventListener(SERVER_LOGIN_APPROVE_EVENT, take)
    seen.length = 0
  })

  it('没有页面接(桌面)⇒ 不认领,链接去浏览器', () => {
    expect(openAppLink(LINK)).toBe(false)
    expect(chatLinks(undefined)(LINK)).toBe(false)
  })

  it('手机壳挂着批准页 ⇒ 聊天里点与系统交来的都交给它', () => {
    window.addEventListener(SERVER_LOGIN_APPROVE_EVENT, take)
    expect(chatLinks(undefined)(LINK)).toBe(true)
    expect(openAppLink(LINK)).toBe(true)
    expect(seen).toEqual(['ABCD-EFGH', 'ABCD-EFGH'])
  })

  it('别的链接不进批准页', () => {
    window.addEventListener(SERVER_LOGIN_APPROVE_EVENT, take)
    expect(chatLinks(undefined)('https://example.com/x')).toBe(false)
    expect(seen).toEqual([])
  })
})
