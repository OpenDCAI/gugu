/**
 * 手机会话页输入框的附件条是**一行横滑**(attachment.aui.tsx 的 `aui-composer-attachments`:flex 一行 + overflow-x-auto)。
 * 一起选十张,每枚 chip 必须保持自己的宽、由条横向滚动;❌ 被压成窄条。
 *
 * 压窄时 chip 自己的 overflow 把名字、错误原因、「重试」、× 全裁掉 —— mac1 实测 5 张起 × 就没了,10 张只剩一排细条:
 * 失败的那张看不见、重传不了、删不掉,发送又被它拦着(手机用户报「传了三五张之后就传不了图」)。
 * 这里在真浏览器里排十枚 error 态 chip,读每枚的几何。
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ComposerAttachmentChip, type ComposerAttachment } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import '@/styles/tokens.css'
import '@renderer/index.css'
import { until } from '../../../../../../../tests/support/awaitCondition'

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  root?.unmount()
  root = null
  host?.remove()
  host = null
})

const failed = (i: number): ComposerAttachment => ({
  id: `a${i}`,
  name: `IMG_2026100${i}.jpg`,
  kind: 'image',
  state: 'error',
  meta: "Didn't reach that machine",
  retryable: true,
})

describe('手机输入框附件条:一起选十张', () => {
  it('每枚 chip 保持自己的宽,× 和「重试」都在 chip 里,条横向滚动', async () => {
    host = document.createElement('div')
    host.className = 'gugu-skin'
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(
      <SessionLocalizationProvider>
        {/* 与 attachment.aui.tsx 的 aui-composer-attachments 同一组布局:一行、不折、横向滚动;宽取手机输入框的内宽。 */}
        <div data-testid="row" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', overflowX: 'auto', width: '330px' }}>
          {Array.from({ length: 10 }, (_, i) => (
            <ComposerAttachmentChip key={i} attachment={failed(i)} onRemove={() => {}} onRetry={() => {}} />
          ))}
        </div>
      </SessionLocalizationProvider>,
    )
    await until('十枚 chip 挂载', () => host!.querySelectorAll('[data-slot="composer-attachment"]').length === 10)

    const row = host.querySelector<HTMLElement>('[data-testid="row"]')!
    const chips = [...host.querySelectorAll<HTMLElement>('[data-slot="composer-attachment"]')]
    for (const chip of chips) {
      // 内容没被 chip 自己的 overflow 裁掉。
      expect(chip.scrollWidth, chip.textContent ?? '').toBeLessThanOrEqual(chip.clientWidth + 1)
      const box = chip.getBoundingClientRect()
      for (const control of chip.querySelectorAll<HTMLElement>('button')) {
        const r = control.getBoundingClientRect()
        expect(r.width, `${control.textContent || control.getAttribute('aria-label')} 有宽度`).toBeGreaterThan(0)
        expect(r.right, `${control.textContent || control.getAttribute('aria-label')} 在 chip 里`).toBeLessThanOrEqual(box.right + 0.5)
      }
      // × 与「重试」两颗都在。
      expect(chip.querySelectorAll('button').length).toBe(2)
    }
    // 放不下的那些靠条横向滚出来,❌ 挤进这一屏。
    expect(row.scrollWidth).toBeGreaterThan(row.clientWidth)
  })
})
