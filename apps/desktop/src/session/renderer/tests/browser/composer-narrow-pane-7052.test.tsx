import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n } from '@/i18n'
import { ChatComposer } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { composerModelOptions } from '@renderer/features/sessions/session-config/platform-model-options'
import { modelProviderIcon } from '@renderer/features/sessions/session-config/model-provider-icon'
// 主题层与同目录 composer-model-menu-3249 同一套(理由见那份文件顶部)。
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

/**
 * #7052 一格最窄 220px:会话那一格里的输入框只剩一百六十来宽。2026-10-09 实测(三块并排再分一格):
 * 档 3 收完还是放不下,用量读数和权限图标叠在一起,发送键被顶出卡片 —— 看不见、点不到。
 *
 * 判据:底排照会话里真有的那几颗摆(附件、完全访问、用量读数、锁着的 agent、带厂商图形的模型),
 * 卡片 194px 宽(格子 220 减去两侧留白)时,发送键与附件键都整个落在底排里、谁也不压谁。
 * ❌ 只判「data-disclosure 到了某档」:档位到了不等于放下了,那是这条判据要防的假绿。
 */

const MODELS = () =>
  composerModelOptions(
    { 'gpt-5.6-sol': { name: 'GPT-5.6 Sol', description: '400K 上下文' } },
    [
      {
        id: 'deepseek-v4-pro',
        displayName: 'DeepSeek V4 Pro',
        protocol: 'openai-chat-completions',
        creditMultiplier: 0.5,
        contextWindow: 1_000_000,
        reasoningEfforts: null,
      },
    ],
    { ownTierLabel: '你的 Codex 模型', icon: modelProviderIcon }
  )

let root: Root | null = null
let container: HTMLDivElement | null = null
let previousLanguage = 'zh-CN'

beforeEach(async () => {
  previousLanguage = i18n.language
  await i18n.changeLanguage('zh-CN')
  await page.viewport(1200, 700)
  document.body.style.margin = '0'
  container = document.createElement('div')
  container.className = 'gugu-skin'
  container.style.width = '194px'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  root?.unmount()
  container?.remove()
  root = null
  container = null
  await i18n.changeLanguage(previousLanguage)
})

const rect = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect() ?? null

function renderComposer() {
  const models = MODELS()
  const platformId = Object.keys(models ?? {}).find((id) => id.startsWith('platform:'))!
  root!.render(
    <SessionLocalizationProvider>
      <ChatComposer
        modelOptions={models}
        selectedModel={platformId}
        onModelChange={() => {}}
        agentOptions={[{ id: 'codex', name: 'Codex', icon: <svg width="14" height="14" /> }]}
        selectedAgent="codex"
        agentLocked
        permissionModeOptions={{ full: { name: '完全访问', destructive: true } }}
        selectedPermissionMode="full"
        contextUsage={{ used: 51_000, size: 1_000_000, costSource: 'platform' }}
        onAttach={() => {}}
        onSubmit={() => {}}
        onStop={() => {}}
      />
    </SessionLocalizationProvider>
  )
}

describe('会话里最窄那一格的输入框 (#7052)', () => {
  it('194px 宽:发送键和附件键整个在底排里,谁也不压谁', async () => {
    renderComposer()
    const toolbar = '[data-slot="composer-toolbar"]'
    const send = `${toolbar} button[aria-label="发送消息"]`
    const attach = `${toolbar} button[aria-label="添加附件"]`
    await until('底排画出来', () => rect(send) !== null && rect(attach) !== null)
    // 阶梯逐档爬:每档一次重排,停在放得下的那一档。
    await until('阶梯停下', () => {
      const bar = document.querySelector(toolbar)!
      const before = bar.getAttribute('data-disclosure')
      return before !== null && Number(before) >= 1
    })
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))

    const bar = rect(toolbar)!
    const sendBox = rect(send)!
    const attachBox = rect(attach)!
    expect(sendBox.left).toBeGreaterThanOrEqual(bar.left)
    expect(sendBox.right).toBeLessThanOrEqual(bar.right + 0.5)
    expect(attachBox.left).toBeGreaterThanOrEqual(bar.left)

    // 底排里看得见的每一颗都不压到下一颗身上(实测翻车的形状:权限图标压在用量读数上)。
    const visible = [...document.querySelectorAll<HTMLElement>(`${toolbar} button`)]
      .map((el) => el.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0)
      .sort((a, b) => a.left - b.left)
    for (let i = 1; i < visible.length; i++) {
      expect(visible[i].left, `第 ${i} 颗压到前一颗`).toBeGreaterThanOrEqual(visible[i - 1].right - 1)
    }
  })
})
