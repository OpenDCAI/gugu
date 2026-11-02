import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store'
import { usePhoneNewTask } from '@/mobile/chat/PhoneNewTask'
import { ComposerAttachButton } from '@/components/chat/ComposerAttachButton'
import {
  createReactHarness,
  renderWithAppProviders
} from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { composerModelOptions } from '@renderer/features/sessions/session-config/platform-model-options'
import { modelProviderIcon } from '@renderer/features/sessions/session-config/model-provider-icon'
import { i18n } from '@/i18n'
import { Zap } from '@/lib/icons'
import '@/i18n/registerMessagingCatalog'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({
  ...(await original<object>()),
  getSupabaseUrl: () => 'http://supabase.test.local',
  getSupabaseAnonKey: () => 'test-anon-key'
}))
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: { chatView: 'double' } })
}))
vi.mock('@/components/chat/useConversationOptions', () => ({
  useConversationOptions: () => {
    const models = composerModelOptions(
      {},
      [
        {
          id: 'gpt-6-luna',
          displayName: '咕咕 GPT-6 Luna',
          protocol: 'openai-chat-completions',
          creditMultiplier: 1,
          contextWindow: 1000000,
          reasoningEfforts: null
        }
      ],
      { ownTierLabel: 'Codex', icon: modelProviderIcon }
    )
    return {
      props: {
        modelOptions: models,
        selectedModel: Object.keys(models!)[0],
        permissionModeOptions: { full: { name: '完全访问', destructive: true } },
        selectedPermissionMode: 'full'
      },
      confirmation: null,
      steers: false
    }
  }
}))
vi.mock('@/mobile/chat/phoneTaskFolders', () => ({
  taskFoldersOfChat: () => ({ memberIds: [], folders: [], homeOf: () => undefined })
}))
vi.mock('@/mobile/chat/usePhoneFolderAttach', () => ({
  usePhoneFolderAttach: () => ({ added: [], fresh: new Set(), picker: null })
}))

let harness: ReturnType<typeof createReactHarness>
afterEach(() => {
  harness?.cleanup()
  document.body.replaceChildren()
  delete document.documentElement.dataset.theme
})
const out = '__screenshots__/acceptance1292'

it('1292 phone SessionConversation renders its locked harness before the model', async () => {
  await i18n.changeLanguage('zh-CN')
  await page.viewport(390, 844)
  document.documentElement.dataset.theme = 'light'
  harness = createReactHarness()
  harness.container.setAttribute('data-phone-shell', '')
  harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column'
  await renderWithAppProviders(
    harness,
    <SessionConversation
      timeline={emptyAgentWatchTimeline()}
      deviceId="device"
      sessionId="acceptance-1292"
      agentName="Codex"
      harness="codex"
      nativeRecord
      sessionRuntime="acp"
      respondingItemId={null}
      onRespond={vi.fn()}
      onSend={vi.fn()}
      pendingSends={[]}
      sending={false}
      agentWorking={false}
      onStop={vi.fn()}
      stopping={false}
      onLoadOlder={vi.fn()}
    />,
    { contacts: {} }
  )
  await until(
    'phone composer model',
    () => !!harness.container.querySelector('[data-testid="composer-model-trigger"]')
  )
  await new Promise((r) => setTimeout(r, 600))
  const locked = harness.container.querySelector<HTMLButtonElement>(
    'button[disabled][aria-label*="Codex"]'
  )!
  const model = harness.container.querySelector('[data-testid="composer-model-trigger"]')!
  expect(locked).not.toBeNull()
  expect(locked.getBoundingClientRect().width).toBeGreaterThan(0)
  expect(getComputedStyle(locked).opacity).toBe('1')
  expect(locked.getBoundingClientRect().right).toBeLessThanOrEqual(
    model.getBoundingClientRect().left
  )
  expect(Math.abs(locked.getBoundingClientRect().y - model.getBoundingClientRect().y)).toBeLessThan(
    8
  )
  const send = harness.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!
  expect(
    locked.getBoundingClientRect().bottom <= send.getBoundingClientRect().top ||
      locked.getBoundingClientRect().right <= send.getBoundingClientRect().left
  ).toBe(true)
  const permission = harness.container
    .querySelector('[data-slot="composer-permission-mode"]')!
    .closest('button')!
  expect(permission.getBoundingClientRect().right).toBeLessThanOrEqual(
    locked.getBoundingClientRect().left
  )
  expect(model.querySelector('[role="img"]')?.getBoundingClientRect().width ?? 0).toBe(0)
  await page.screenshot({ path: `${out}/phone-session-component.png` })
})

it('1292 phone project attachment menu uses the real new-task action lightning', async () => {
  await i18n.changeLanguage('zh-CN')
  await page.viewport(390, 844)
  document.documentElement.dataset.theme = 'light'
  harness = createReactHarness()
  function Fixture() {
    const task = usePhoneNewTask({ chatId: 'project-group', enabled: true, clear: () => {} })
    return (
      <div data-phone-shell="" style={{ padding: 16, marginTop: 600 }}>
        <span hidden data-zap-control>
          <Zap size={16} />
        </span>
        <ComposerAttachButton
          actions={task.action ? [task.action] : []}
          disabled={false}
          mobile
          onPickFile={() => {}}
        />
      </div>
    )
  }
  await renderWithAppProviders(harness, <Fixture />, { contacts: {} })
  await userEvent.click(page.getByTestId('chat-composer-attach-menu'))
  await until(
    'real phone new-task action',
    () => !!document.querySelector('[data-testid="chat-composer-attach-phone-new-task"]')
  )
  const task = document.querySelector('[data-testid="chat-composer-attach-phone-new-task"]')!
  expect(task.textContent).toContain('新任务')
  expect(task.querySelector('svg')).not.toBeNull()
  expect(task.querySelector('svg')!.innerHTML).toBe(
    document.querySelector('[data-zap-control] svg')!.innerHTML
  )
  await page.screenshot({ path: `${out}/phone-task-menu-component.png` })
})
