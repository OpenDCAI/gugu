import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { ChatBottomDock } from '@/components/chat/ChatBottomDock'
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store'
import { startPhoneNewTask } from '@/mobile/chat/PhoneNewTask'
import { DevicesContext, useDevicesStore } from '@/store/devicesContext'
import { publishRendererSession } from '@/lib/sessionPublication'
import { chatService } from '@/lib/chat'
import { i18n } from '@/i18n'
import '@/i18n/registerMessagingCatalog'
import { createReactHarness, device, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

const fixture = vi.hoisted(() => ({ theme: 'light' as 'light' | 'dark' }))
vi.mock('@/store/theme', async original => ({ ...await original<object>(),
  useTheme: () => ({ theme: fixture.theme, preference: fixture.theme, setTheme: vi.fn() }) }))
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: { chatView: 'double' } }) }))
vi.mock('@/components/chat/useConversationOptions', () => ({ useConversationOptions: () => ({
  props: { permissionModeOptions: { full: { name: '完全访问' } }, selectedPermissionMode: 'full',
    modelOptions: { model: { name: '测试模型' } }, selectedModel: 'model' }, confirmation: null, steers: false,
}) }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async original => ({ ...await original<object>(),
  fetchBackgroundTasks: vi.fn(async () => []),
  fetchCreateOptions: vi.fn(async () => ({ projects: [], lastUsed: null, harnesses: [{ id: 'codex', name: 'Codex',
    status: 'available', watchable: true, sessionViews: ['general'], permissionModes: ['full-access'] }] })),
  fetchCreateModels: vi.fn(async () => ({ harness: 'codex', transport: 'acp', selected: 'model', selectedEffort: null,
    efforts: [], harnessState: 'ready', harnessReason: null, guguReason: null, harnessAuth: 'signed-in',
    selectedCredential: 'credentialed', models: [{ id: 'model', name: '测试模型', source: 'harness' }] })),
}))
vi.mock('@/lib/attachmentsEndpoint', async original => ({ ...await original<object>(),
  prepareTaskAttachment: async () => null,
  placeTaskAttachment: async (file: File) => ({ itemId: file.name, version: 1, name: file.name, mimeType: file.type, sizeBytes: file.size }),
}))
vi.mock('@/mobile/agent-watch/useSessionLifeView', () => ({ useSessionLifeView: () => ({ view: null, error: null }) }))

type Surface = 'single' | 'group' | 'topic' | 'agent' | 'new-task'
const surfaces: Surface[] = ['single', 'group', 'topic', 'agent', 'new-task']
const labels: Record<Surface, string> = { single: '普通单聊', group: '群聊', topic: '话题', agent: 'Agent 会话', 'new-task': '新建任务' }
const cases = surfaces.flatMap(surface => (['light', 'dark'] as const).flatMap(theme =>
  [1, 5, 10].map(count => ({ surface, theme, count, width: 390 }))))
cases.push(...(['single', 'agent', 'new-task'] as const).flatMap(surface =>
  (['light', 'dark'] as const).map(theme => ({ surface, theme, count: 10, width: 320 }))))
let harness: ReturnType<typeof createReactHarness>
const screenshotHead = import.meta.env.VITE_QA_SOURCE_HEAD as string | undefined

function ProjectTaskComposer() {
  const base = useDevicesStore()
  return <DevicesContext.Provider value={{ ...base, devices: [device('machine', [], { projects: [{
    localProjectId: 'project', name: '测试项目', rootPath: '/fixture', createdAt: '2026-11-07T00:00:00Z', chatId: 'position-task',
    folders: [{ workspaceId: 'workspace', kind: 'root', path: '/fixture', attachedAt: null }],
  }] })] }}><ChatMessageComposer chatId="position-task" isGroupChat onSend={vi.fn()} /></DevicesContext.Provider>
}

function Composer({ surface }: { surface: Surface }) {
  if (surface === 'agent') return <SessionConversation timeline={emptyAgentWatchTimeline()} deviceId="machine"
    sessionId="position-session" agentName="Codex" agentUserId="agent" harness="codex" sessionRuntime="acp"
    respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false}
    agentWorking={false} onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} />
  if (surface === 'new-task') return <ProjectTaskComposer />
  return <ChatMessageComposer chatId={`position-${surface}`} isGroupChat={surface !== 'single'}
    surface={surface === 'topic' ? 'aside' : 'main'} placeholder={surface === 'topic' ? '回复话题…' : undefined} onSend={vi.fn()} />
}

beforeEach(async () => {
  await page.viewport(390, 844)
  await i18n.changeLanguage('zh-CN')
  publishRendererSession('SIGNED_IN', { user: { id: 'owner' } } as never)
  vi.spyOn(chatService, 'getOrCreateDM').mockResolvedValue('fixture-dm')
  harness = createReactHarness()
  harness.container.setAttribute('data-phone-shell', '')
  harness.container.setAttribute('data-ta-scope', '')
  document.body.style.margin = '0'
  harness.container.style.cssText = 'position:relative;width:390px;height:760px;background:var(--bg);color:var(--text-primary);display:flex;flex-direction:column'
})
afterEach(() => {
  harness.cleanup()
  document.body.style.removeProperty('margin')
  document.documentElement.removeAttribute('data-theme')
})

async function pick(count: number) {
  const picker = harness.container.querySelector<HTMLInputElement>('input[type="file"][multiple]')!
  const files = new DataTransfer()
  for (let index = 0; index < count; index++) files.items.add(new File(['非敏感测试附件'], `附件-${index + 1}.txt`, { type: 'text/plain' }))
  await act(async () => { picker.files = files.files; picker.dispatchEvent(new Event('change', { bubbles: true })) })
  await until('all picked files have real tiles', () => harness.container.querySelectorAll('[data-slot="composer-attachment"]').length === count)
}

it.each(cases)('$surface/$theme/$count/$width: pending files align above the editor', async ({ surface, theme, count, width }) => {
  await page.viewport(width, 844)
  harness.container.style.width = `${width}px`
  fixture.theme = theme
  document.documentElement.dataset.theme = theme
  await renderWithAppProviders(harness, <>
    <header style={{ padding: 12, overflowWrap: 'anywhere', fontSize: 12 }}>
      {width}px 模拟截图 · {labels[surface]} · {theme === 'light' ? '浅色' : '深色'} · {count} 个附件
      {screenshotHead && <div>源码 {screenshotHead}</div>}
    </header>
    <div style={{ flex: 1, minHeight: 80 }} />
    {surface === 'agent' ? <Composer surface={surface} /> : <ChatBottomDock reserve><Composer surface={surface} /></ChatBottomDock>}
  </>, { contacts: {} })
  await until('normal file picker mounts', () => !!harness.container.querySelector('input[type="file"][multiple]'))
  if (surface === 'new-task') {
    await act(async () => { startPhoneNewTask('position-task') })
    await until('project folder chooser mounts', () => !!harness.container.querySelector('[data-testid="project-folder-paper"]'))
    await act(async () => { harness.container.querySelector<HTMLElement>('[data-testid="project-folder-paper"]')!.click() })
    await until('new task mode active', () => !!harness.container.querySelector('[data-phone-task]'))
  }
  await pick(count)
  const row = harness.container.querySelector<HTMLElement>('[data-slot="composer-attachments"]')!
  const input = harness.container.querySelector<HTMLElement>('[data-slot="composer-input"]')!
  await until('the complete editor is visible within the phone screenshot', () =>
    input.getBoundingClientRect().bottom <= harness.container.getBoundingClientRect().bottom + 1)
  if (screenshotHead) {
    expect(screenshotHead).toMatch(/^[a-f0-9]{40}$/)
    await page.screenshot({ element: harness.container, path: `__screenshots__/attachment-position-1945/${surface}-${theme}-${count}-${width}-${screenshotHead.slice(0, 8)}.png` })
  }
  expect(row.getBoundingClientRect().bottom, 'the entire attachment grid must be above the text editor').toBeLessThanOrEqual(input.getBoundingClientRect().top + 1)
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth)
  const chips = [...row.querySelectorAll<HTMLElement>('[data-slot="composer-attachment"]')]
  const contentLeft = input.getBoundingClientRect().left + parseFloat(getComputedStyle(input).paddingLeft)
  expect(Math.abs(chips[0]!.getBoundingClientRect().left - contentLeft), 'attachments align with the editor content edge').toBeLessThanOrEqual(1)
  expect(chips[0]!.getBoundingClientRect().top).toBeLessThan(input.getBoundingClientRect().top)
  if (count > 5) expect(chips[5]!.getBoundingClientRect().top).toBeGreaterThan(chips[0]!.getBoundingClientRect().top)
  const permission = harness.container.querySelector<HTMLElement>('[data-slot="composer-permission-mode"]')?.closest('button')
  if (surface === 'agent') {
    expect(permission).not.toBeNull()
    expect(permission!.getBoundingClientRect().bottom).toBeLessThanOrEqual(row.getBoundingClientRect().top + 1)
  }
})
