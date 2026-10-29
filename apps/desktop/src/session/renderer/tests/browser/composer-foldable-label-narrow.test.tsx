import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n } from '@/i18n'
import { ChatComposer } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { composerModelOptions } from '@renderer/features/sessions/session-config/platform-model-options'
import { modelProviderIcon } from '@renderer/features/sessions/session-config/model-provider-icon'
import { publishDefaultTaskAgent } from '@/lib/composerVerbBridge'
import type { AgentIconAsset } from '@shared/core/agents/agent-payload'
import { icon as codexIcon } from '../../../../../../../packages/session-plugins/src/agents/impl/codex/icon'
// 主题层与同目录 composer-narrow-pane-7052 同一套。
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@renderer/lib/stores/use-agents', async (original) => ({
  ...(await original<object>()),
  useAgentIcon: (id: string) => (id === 'codex' ? codexIcon : null),
}))

const { SessionComposerVerbs } = await import('@renderer/features/sessions/session-verb-dock')
const { composerVerbLook } = await import('@renderer/features/sessions/composer-verb-tag')

/**
 * 分屏后会话那一格只剩两百来宽(10-28 实测:窗口 800、两块并排,会话框 213px):
 * 底排的阶梯收到最后一档,模型只剩厂商图形,可宿主塞进来的「新任务」那颗还整段写着字,压在模型图形和发送键上;
 * 输入行最前那枚「新任务 ×」把编辑区挤到 30px。
 * 判据:框窄到底排最后一档时,这两处的字收掉、标还在(composer-foldable-label);底排里谁也不压谁。框宽时字照旧在。
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
  document.body.appendChild(container)
  root = createRoot(container)
  publishDefaultTaskAgent({ id: 'codex', icon: codexIcon as AgentIconAsset })
})

afterEach(async () => {
  root?.unmount()
  container?.remove()
  root = null
  container = null
  publishDefaultTaskAgent(null)
  await i18n.changeLanguage(previousLanguage)
})

const TOOLBAR = '[data-slot="composer-toolbar"]'
const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))
const shown = (el: Element | null) => !!el && el.getBoundingClientRect().width > 0

async function renderComposer(width: number, { tag }: { tag: boolean }) {
  container!.style.width = `${width}px`
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
        // 会话里 agent 已经定了(锁着,档 5 让位);新任务的框里还能选。
        agentLocked={!tag}
        permissionModeOptions={{ full: { name: '完全访问', destructive: true } }}
        selectedPermissionMode="full"
        leading={tag ? composerVerbLook('task', { label: '新任务', onCancel: () => {}, testId: 'tag' }).tag('codex') : undefined}
        toolbarExtra={tag ? undefined : <SessionComposerVerbs sessionId="s-1" draft="" onCarried={() => {}} />}
        onAttach={() => {}}
        onSubmit={() => {}}
        onStop={() => {}}
      />
    </SessionLocalizationProvider>
  )
  await until('底排画出来', () => document.querySelector(`${TOOLBAR} button[aria-label="发送消息"]`) !== null)
  // 阶梯逐档爬,每档一次重排;等它停下(连续几帧档位不变)。
  let last: string | null = null
  for (let same = 0, frames = 0; same < 3 && frames < 120; frames++) {
    await settle()
    const now = document.querySelector(TOOLBAR)?.getAttribute('data-disclosure') ?? null
    same = now !== null && now === last ? same + 1 : 0
    last = now
  }
}

describe('窄框里宿主塞进来的「新任务」收成标', () => {
  it('会话底排 213px:「新任务」只剩 agent 的标,不压模型图形和发送键', async () => {
    await renderComposer(213, { tag: false })
    const verb = document.querySelector('[data-testid="session-verb-task"]')!
    expect(verb.getAttribute('aria-label')).toBe(verb.getAttribute('title'))
    expect(shown(verb.querySelector('svg, img')), '标还在').toBe(true)
    expect(shown(verb.querySelector('[data-slot="composer-foldable-label"]')), '字收掉').toBe(false)
    const visible = [...document.querySelectorAll<HTMLElement>(`${TOOLBAR} button`)]
      .map((el) => el.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0)
      .sort((a, b) => a.left - b.left)
    const bar = document.querySelector(TOOLBAR)!.getBoundingClientRect()
    for (let i = 1; i < visible.length; i++) {
      expect(visible[i].left, `第 ${i} 颗压到前一颗`).toBeGreaterThanOrEqual(visible[i - 1].right - 1)
    }
    expect(visible.at(-1)!.right).toBeLessThanOrEqual(bar.right + 0.5)
  })

  it('会话底排宽:「新任务」照旧写着字', async () => {
    await renderComposer(640, { tag: false })
    expect(shown(document.querySelector('[data-testid="session-verb-task"] [data-slot="composer-foldable-label"]'))).toBe(true)
  })

  it('没有默认 agent(没有标):字不收,❌ 收成一颗空按钮', async () => {
    publishDefaultTaskAgent(null)
    await renderComposer(213, { tag: false })
    const verb = document.querySelector('[data-testid="session-verb-task"]')!
    expect(verb.querySelector('[data-slot="composer-foldable-label"]')).toBeNull()
    expect(verb.textContent).toContain('新任务')
  })

  it('输入行最前那枚「新任务 ×」在窄框里只剩标和 ×,编辑区不被挤没', async () => {
    await renderComposer(192, { tag: true })
    const tag = document.querySelector('[data-testid="tag-verb"]')!
    expect(tag.getAttribute('title')).toBe('新任务')
    expect(shown(tag.querySelector('[data-slot="composer-foldable-label"]'))).toBe(false)
    expect(shown(document.querySelector('[data-testid="tag-cancel"]'))).toBe(true)
    // 父版实测编辑区只剩 30px,placeholder 一行两个字。
    const editor = document.querySelector('[data-testid="prompt-editor"]')!.getBoundingClientRect()
    expect(editor.width).toBeGreaterThan(80)
  })

  it('框宽时那枚标签照旧写着字', async () => {
    await renderComposer(640, { tag: true })
    expect(shown(document.querySelector('[data-testid="tag-verb"] [data-slot="composer-foldable-label"]'))).toBe(true)
  })
})
