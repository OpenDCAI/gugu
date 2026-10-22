import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { ChatComposer } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { sessionComposerEmptyHeightPx } from '@renderer/features/sessions/session-composer-styles'
// 主题层与同目录 composer-narrow-pane-7052 同一套。
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

/**
 * gugu-dev#181 核对 21:会话页、新建会话页的输入框和格子里的群框空着时同高。群框读的是 `sessionComposerEmptyHeightPx`,
 * 这里量真的会话输入框(编辑区 66px 含内距 + 底排 + 边框),两边谁改了谁就红 —— ❌ 两处各写一个数。
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

describe('the empty composer\'s height', () => {
  it('is the height the group box in a block keeps', async () => {
    root!.render(
      <SessionLocalizationProvider>
        <ChatComposer onSubmit={() => {}} onStop={() => {}} onAttach={() => {}} />
      </SessionLocalizationProvider>
    )
    const card = () => document.querySelector<HTMLElement>('[data-slot="composer-bar"]')
    await until('输入框画出来', () => (card()?.getBoundingClientRect().height ?? 0) > 0)
    expect(Math.round(card()!.getBoundingClientRect().height)).toBe(sessionComposerEmptyHeightPx)
  })
})
