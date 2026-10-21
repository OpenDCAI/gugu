import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGroupInviteQrPayload, createGuguQrScanUrl } from '@gugu/core/shared/qrPayload'
import {
  scanGuguLinks,
  splitGuguLinkSegments,
} from '../../../../apps/desktop/src/lib/guguLinkScan'
const WEB_BASE = 'https://app.gugu.nextmind.space/invite'
function inviteLink(publicId: number, token: string): string {
  return createGuguQrScanUrl(createGroupInviteQrPayload(publicId, token), { downloadUrl: WEB_BASE })
}
afterEach(() => vi.unstubAllEnvs())
describe('scanGuguLinks (#3303)', () => {
  it.each([
    ['首部', (link: string) => `${link} 后文`],
    ['中间', (link: string) => `前文 ${link} 后文`],
    ['尾部', (link: string) => `前文 ${link}`],
  ])('识别位于正文%s的链接，并保留精确 offset', (_label, makeText) => {
    vi.stubEnv('VITE_GUGU_WEB_URL', 'https://app.gugu.nextmind.space')
    const link = inviteLink(778899, 'token-a')
    const text = makeText(link)
    expect(scanGuguLinks(text)).toEqual([{
      raw: link,
      start: text.indexOf(link),
      end: text.indexOf(link) + link.length,
      route: { nav: 'group_join', publicId: 778899, joinToken: 'token-a' },
    }])
  })
  it('一段正文可识别多个链接，中文标点不吞进 raw', () => {
    vi.stubEnv('VITE_GUGU_WEB_URL', 'https://app.gugu.nextmind.space')
    const first = inviteLink(11, 'one')
    const second = inviteLink(22, 'two')
    const text = `甲：${first}，乙：${second}。`
    expect(scanGuguLinks(text).map((match) => [match.raw, match.route])).toEqual([
      [first, { nav: 'group_join', publicId: 11, joinToken: 'one' }],
      [second, { nav: 'group_join', publicId: 22, joinToken: 'two' }],
    ])
  })
  it('识别不同 origin/path 上的有效 payload，不依赖本构建发出 base', () => {
    vi.stubEnv('VITE_GUGU_WEB_URL', 'https://app.gugu.nextmind.space')
    const crossBase = createGuguQrScanUrl(createGroupInviteQrPayload(33, 'cross-base'), {
      downloadUrl: 'https://sender.example/some/other/path?campaign=summer',
    })
    expect(scanGuguLinks(crossBase)).toEqual([{
      raw: crossBase,
      start: 0,
      end: crossBase.length,
      route: { nav: 'group_join', publicId: 33, joinToken: 'cross-base' },
    }])
  })
  it('普通 URL、非 HTTP(S) carrier 和畸形 payload 都不误判且不抛错', () => {
    const malformed = `${WEB_BASE}?gugu_qr=%7Bbad-json`
    const nonHttp = inviteLink(33, 'wrong').replace('https://', 'gugu://')
    const text = `https://example.com ${nonHttp} ${malformed}`
    expect(() => scanGuguLinks(text)).not.toThrow()
    expect(scanGuguLinks(text)).toEqual([])
  })
  it('按命中结果切成无丢字的文本段与链接段', () => {
    vi.stubEnv('VITE_GUGU_WEB_URL', 'https://app.gugu.nextmind.space')
    const link = inviteLink(44, 'segment')
    const text = `前${link}后`
    expect(splitGuguLinkSegments(text)).toEqual([
      { kind: 'text', text: '前', start: 0, end: 1 },
      {
        kind: 'link',
        raw: link,
        start: 1,
        end: 1 + link.length,
        route: { nav: 'group_join', publicId: 44, joinToken: 'segment' },
      },
      { kind: 'text', text: '后', start: 1 + link.length, end: text.length },
    ])
  })
})
