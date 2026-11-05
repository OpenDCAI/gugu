import { describe, expect, it } from 'vitest'
import { createGroupInviteQrPayload, createGuguQrScanUrl } from '@gugu/core/shared/qrPayload'
import { resolveQrScanRoute } from '../../../../apps/desktop/src/lib/qrScanRoute'

const WEB_BASE = 'https://app.gugu.nextmind.space/invite'

describe('resolveQrScanRoute', () => {
  it('a group invite link resolves to a token-gated join', () => {
    const link = createGuguQrScanUrl(createGroupInviteQrPayload(778899, 'token-a'), { downloadUrl: WEB_BASE })
    expect(resolveQrScanRoute(link)).toEqual({ nav: 'group_join', publicId: 778899, joinToken: 'token-a' })
  })

  it('reads the payload on any origin and path, not only the one this build emits (#3303)', () => {
    const crossBase = createGuguQrScanUrl(createGroupInviteQrPayload(33, 'cross-base'), {
      downloadUrl: 'https://sender.example/some/other/path?campaign=summer',
    })
    expect(resolveQrScanRoute(crossBase)).toEqual({ nav: 'group_join', publicId: 33, joinToken: 'cross-base' })
  })

  it('a plain URL or a malformed payload resolves to nothing, without throwing', () => {
    expect(resolveQrScanRoute('https://example.com')).toBeNull()
    expect(resolveQrScanRoute(`${WEB_BASE}?gugu_qr=%7Bbad-json`)).toBeNull()
  })
})
