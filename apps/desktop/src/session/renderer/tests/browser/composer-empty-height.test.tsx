import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { ChatComposer } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { sessionComposerBox, sessionComposerEmptyHeightPx } from '@renderer/features/sessions/session-composer-styles'
// 主题层与同目录 composer-narrow-pane-7052 同一套。
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

/**
 * gugu-dev#181 核对 21:会话页、新建会话页的输入框和格子里的群框是同一个框 —— 一样高,文字、底排在同一个位置。
 * 群框读的是 `sessionComposerBox` / `sessionComposerEmptyHeightPx`,这里量真的会话输入框,两边谁改了谁就红 —— ❌ 两处各写一个数。
 */
let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(async () => {
  await page.viewport(1200, 700)
  document.body.style.margin = '0'
  container = document.createElement('div')
  container.className = 'gugu-skin'
  container.style.width = '768px'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root?.unmount()
  container?.remove()
  root = null
  container = null
})

describe('the session composer\'s box', () => {
  it('is the box the group box in a block draws: its height, where the words start, where the bottom row sits', async () => {
    root!.render(
      <SessionLocalizationProvider>
        <ChatComposer
          permissionModeOptions={{ full: { name: '完全访问', destructive: true } }}
          selectedPermissionMode="full"
          onSubmit={() => {}}
          onStop={() => {}}
          onAttach={() => {}}
        />
      </SessionLocalizationProvider>
    )
    const card = () => document.querySelector<HTMLElement>('[data-slot="composer-bar"]')
    await until('输入框画出来', () => (card()?.getBoundingClientRect().height ?? 0) > 0)
    const box = card()!.getBoundingClientRect()
    const border = 1
    expect(Math.round(box.height)).toBe(sessionComposerEmptyHeightPx)

    const words = document.querySelector<HTMLElement>('[data-slot="composer-bar"] .ProseMirror')!.getBoundingClientRect()
    expect(Math.round(words.left - box.left - border)).toBe(sessionComposerBox.textInsetPx)
    expect(Math.round(box.right - border - words.right)).toBe(sessionComposerBox.textInsetPx)
    expect(Math.round(words.top - box.top - border)).toBe(sessionComposerBox.textTopPx)

    const controls = [...document.querySelectorAll<HTMLElement>('[data-slot="composer-toolbar"] button')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0)
      .sort((a, b) => a.left - b.left)
    const [first, second] = controls
    expect(Math.round(first.left - box.left - border)).toBe(sessionComposerBox.toolbarInsetPx)
    expect(Math.round(box.bottom - border - first.bottom)).toBe(sessionComposerBox.toolbarInsetPx)
    expect(Math.round(first.height)).toBe(sessionComposerBox.toolbarControlPx)
    expect(Math.round(second.left - first.right)).toBe(sessionComposerBox.toolbarGapPx)
  })
})
