// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyPosterToClipboard, drawSharePoster } from '../../../../apps/desktop/src/components/sharePosterCanvas'
function canvasContext() {
  const gradient = { addColorStop: vi.fn() }
  return {
    scale: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textBaseline: '',
    textAlign: '',
    createLinearGradient: vi.fn(() => gradient),
    measureText: vi.fn(() => ({ width: 40 })),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    closePath: vi.fn(),
    save: vi.fn(),
    clip: vi.fn(),
    rect: vi.fn(),
    restore: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D
}
function drawWithContext(memberAvatarUrls: unknown[], images = new Map<string, HTMLImageElement>()) {
  const context = canvasContext()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
  drawSharePoster({
    title: '研究小组',
    subtitle: '群聊 · 1 位成员',
    qrDataUrl: 'data:image/png;base64,qr',
    memberAvatarUrls: memberAvatarUrls as string[],
    totalMemberCount: memberAvatarUrls.length,
  }, images)
  return context
}
afterEach(() => vi.restoreAllMocks())
it('preserves the clipboard rejection after encoding the poster as a resolved PNG blob', async () => {
  const error = new Error('Clipboard permission denied')
  const write = vi.fn().mockRejectedValue(error)
  vi.stubGlobal('navigator', { clipboard: { write } })
  vi.stubGlobal('ClipboardItem', class { constructor(readonly data: Record<string, Blob>) {} })
  const blob = new Blob(['png'], { type: 'image/png' })
  const canvas = { toBlob: (callback: BlobCallback) => callback(blob) } as HTMLCanvasElement
  try {
    await expect(copyPosterToClipboard(canvas)).rejects.toBe(error)
    expect(write).toHaveBeenCalledWith([expect.objectContaining({ data: { 'image/png': blob } })])
  } finally { vi.unstubAllGlobals() }
})
describe('share poster canonical avatar slots', () => {
  it('diagnoses an invalid sentinel string and preserves its explicit poster slot', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const context = drawWithContext(['undefined'])
    expect(errors).toHaveBeenCalledWith('[Avatar] invalid avatar URL at poster member slot 0: "undefined"')
    expect(context.drawImage).not.toHaveBeenCalled()
    expect(context.stroke).toHaveBeenCalledTimes(2)
  })
  it('keeps a legitimate missing poster avatar silent', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const context = drawWithContext([null])
    expect(errors).not.toHaveBeenCalled()
    expect(context.drawImage).not.toHaveBeenCalled()
  })
  it('keeps the group layout and an explicit empty slot when every member lacks an avatar', () => {
    const context = drawWithContext([null])
    // One stroke is the poster divider; the extra stroke is the visible empty avatar slot.
    expect(context.stroke).toHaveBeenCalledTimes(2)
    expect(context.drawImage).not.toHaveBeenCalled()
  })
  it('diagnoses a canonical avatar that failed to load instead of silently painting a dark block', () => {
    const failedImage = { naturalWidth: 0 } as HTMLImageElement
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const context = drawWithContext(['https://cdn.example/avatar.png'], new Map([
      ['https://cdn.example/avatar.png', failedImage],
    ]))
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('failed to load canonical poster avatar'))
    expect(context.drawImage).not.toHaveBeenCalled()
  })
})
describe('share poster group CTA rendering', () => {
  it('wraps English words and clips the CTA before it reaches the group QR', () => {
    const qrImage = { naturalWidth: 280 } as HTMLImageElement
    const context = canvasContext()
    vi.mocked(context.measureText).mockImplementation((text) => ({ width: text.length * 8 } as TextMetrics))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    drawSharePoster(
      {
        title: '研究小组',
        subtitle: '群聊 · 1 位成员',
        qrDataUrl: 'data:image/png;base64,qr',
        memberAvatarUrls: [null],
        totalMemberCount: 1,
        ctaText: 'Scan to join and collaborate with AI',
      },
      new Map([['data:image/png;base64,qr', qrImage]]),
    )
    expect(context.rect).toHaveBeenCalledWith(28, 342, 184, 66)
    expect(context.clip).toHaveBeenCalled()
    const ctaLines = vi.mocked(context.fillText).mock.calls.filter(([, x, y]) => x === 28 && Number(y) >= 342)
    expect(ctaLines.map(([text]) => text)).toEqual([
      'Scan to join and ',
      'collaborate with AI',
    ])
    expect(ctaLines.every(([text]) => context.measureText(String(text)).width <= 184)).toBe(true)
  })
})
