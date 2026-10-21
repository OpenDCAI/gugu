import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { ChatComposer } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
// 主题层与同目录 composer-disabled-options 同一套。
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

/**
 * #7056 会员中途到期,面板那一行上的「换模型」要把模型面板打开 —— 宿主递 `modelMenuOpenRequest`,每变一次开一次。
 * ❌ 宿主去 DOM 里找触发器 click(那是拿测试锚点当产品接口)。阴控:0 / 缺省不开。
 */
const MODELS = {
  'platform:glm-5.3': { name: 'GLM 5.3', groupLabel: '咕咕提供的模型 · 按积分计费' },
  'platform:deepseek-v4-flash': { name: 'DeepSeek V4 Flash', groupLabel: '咕咕提供的模型 · 按积分计费' },
}

let root: Root | null = null
let container: HTMLDivElement | null = null

const panel = () => document.querySelector<HTMLElement>('[data-slot="combobox-content"]')

function render(openRequest: number) {
  root!.render(
    <SessionLocalizationProvider>
      <ChatComposer
        modelOptions={MODELS}
        selectedModel="platform:glm-5.3"
        modelMenuOpenRequest={openRequest}
        onSubmit={() => {}}
        onStop={() => {}}
      />
    </SessionLocalizationProvider>
  )
}

describe('宿主要求打开模型面板', () => {
  beforeEach(async () => {
    await page.viewport(1400, 800)
    container = document.createElement('div')
    container.className = 'emlight gugu-skin bg-background'
    document.body.classList.add('emlight', 'gugu-skin')
    document.body.appendChild(container)
    root = createRoot(container)
    render(0)
    await until(
      'composer model trigger mounted',
      () => document.querySelector('[data-testid="composer-model-trigger"]') != null
    )
  })

  afterEach(() => {
    root?.unmount()
    container?.remove()
    root = null
    container = null
  })

  it('stays closed without a request and opens when the request changes', async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(panel()).toBeNull()

    render(1)
    await until('model panel lists options', () => (panel()?.querySelectorAll('[role="option"]').length ?? 0) > 0)
    expect(panel()!.textContent).toContain('DeepSeek V4 Flash')
  })
})
