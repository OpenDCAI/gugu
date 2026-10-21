/**
 * #6087 「手动指定」指定过之后必须还能改回来 —— 用户填进去的那个值不许成为单程票。
 *
 * owner 原话:「手动指定如果指定过了,点击手动指定就有问题了变得没反应」。票里那台机器上,
 * 手动指定的 `/Users/apple/.local/bin/reclaude` 是他真正在跑的那一份:回不到那个值 = 改不了
 * 也看不见,是死胡同,不是小别扭。
 *
 * 入口又换过一次位置(owner 2026-09-22):来源只有三种 —— 本机找到的 / 咕咕管理 / 自定义路径,
 * 面板上三行并列,「自定义路径」那一行右边是「指定… / 修改」。判据跟着走到那条路上,守的事实
 * 一个字没变:点那个按钮,输入框出来,**并且带着上次填的那个值**。
 *
 * **为什么必须真 Chromium**:判的是「点下去之后屏幕上多了什么」,而那一下要先穿过 Base UI 的
 * 折叠面板。jsdom 里没有真实排版就没有它;类型检查更照不出 —— `isManualRef(...)` 恒为假
 * 不是类型错误。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'

import type { Installation, InstallOption } from '@shared/core/agents/agent-payload'

/** 手动指定留下的那条记录。`resolveActiveInstallation` 找它只看 `id`,不看值 —— 洞就在这儿。 */
function manualInstall(id: 'path' | 'cli', value: string): Installation {
  return {
    id,
    realpath: value,
    pathEntry: value,
    isActive: false,
    manageable: true,
    provenance: { kind: 'manual', confidence: 'confirmed' },
    status: 'available',
    version: '1.0.0',
    latestVersion: null,
    updateAvailable: false,
  }
}

const installations: Installation[] = []
const setUsedCalls: unknown[] = []

const vm = {
  data: null,
  get installations() {
    return installations
  },
  used: undefined as unknown,
  installProgress: null,
  cancelInstall: async () => false,
  status: 'available' as const,
  isInstalling: false,
  isUpdating: false,
  isUninstalling: false,
  lastInstallError: null,
  lastUpdateError: null,
  lastInstallSucceededAt: null,
  installingMethod: undefined,
  installingRegistry: undefined,
  updatingMethod: undefined,
  uninstallingMethod: undefined,
  install: async () => {},
  update: async () => {},
  uninstall: async () => {},
  setUsed: async (selection: unknown) => {
    setUsedCalls.push(selection)
  },
  refresh: async () => {},
  fetchLatestVersion: async () => {},
  probeOverride: async () => null,
}

vi.mock('@renderer/lib/stores/use-agent-installation-statuses', () => ({
  useAgentInstallationStatus: () => vm,
  useInstallSourceVersions: () => ({ data: undefined, isPending: false }),
}))

const { InstallSection } = await import('@renderer/features/settings/agents-page/InstallSection')
const { SessionLocalizationProvider } = await import('@renderer/localization/localization-provider')
await import('@renderer/index.css')

const installOptions: InstallOption[] = [
  { method: 'mise', command: 'mise install npm:claude-code', recommended: true },
]

let root: Root
let host: HTMLDivElement

/** 主题变量挂在 emlight/emdark 上;少了它卡片的底色/层级算不出来。宽度取面板常规宽。 */
beforeEach(() => {
  host = document.createElement('div')
  host.className = 'gugu-skin emlight'
  host.style.width = '520px'
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  root.unmount()
  host.remove()
  installations.length = 0
  setUsedCalls.length = 0
})

function mount(extra: { installDocs?: string } = {}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  root.render(
    <QueryClientProvider client={client}>
      <SessionLocalizationProvider>
        <InstallSection agentId="claude" agentPayload={undefined} installOptions={installOptions} {...extra} />
      </SessionLocalizationProvider>
    </QueryClientProvider>
  )
}

/** 点「自定义路径」那一行的「指定… / 修改」,和用户点的是同一下。 */
async function openManual(): Promise<void> {
  await userEvent.click(page.getByTestId('manual-override-open'))
}

it('手动指定过一个能跑的路径之后,再点那一项输入框带着那个路径回来', async () => {
  const reclaude = '/Users/apple/.local/bin/reclaude'
  installations.push(manualInstall('path', reclaude))
  vm.used = { kind: 'path', path: reclaude }
  mount()
  await openManual()

  const input = page.getByTestId('manual-override-input')
  await until('input is in the document', () => input.query() != null)
  expect(((await input.element()) as HTMLInputElement).value).toBe(reclaude)
})

it('上次填的是命令名时同样带回来 —— ❌ 不是一个空框', async () => {
  // 坏版本里输入框出得来(找不到 `id:'path'`),但 `initialValue` 取的是 `initialPath`,
  // 框是空的 —— 用户填过的东西照样丢。
  installations.push(manualInstall('cli', 'reclaude'))
  vm.used = { kind: 'cli', command: 'reclaude' }
  mount()
  await openManual()

  const input = page.getByTestId('manual-override-input')
  await until('input is in the document', () => input.query() != null)
  expect(((await input.element()) as HTMLInputElement).value).toBe('reclaude')
})

it('阴控:没点「修改」时输入框不在 —— 那一行只显示在用的路径', async () => {
  // 否则上面两条绿只说明「这张卡永远都在」,而不是「点那个按钮才出来」。
  const reclaude = '/Users/apple/.local/bin/reclaude'
  installations.push(manualInstall('path', reclaude))
  vm.used = { kind: 'path', path: reclaude }
  mount()

  // 先等这张卡真的渲出来(那一行在),再判输入框不在 —— 否则「还没渲」也会让「不在」成立。
  const row = page.getByTestId('source-row-custom')
  await until('custom source row renders', () => row.query() != null)
  expect(page.getByTestId('manual-override-input').query(), '没点「修改」时输入框不该在').toBeNull()
  expect((await row.element()).getAttribute('data-in-use')).toBe('true')
  expect((await row.element()).textContent).toContain(reclaude)
})

it('三种来源各一行,在用的那一行标着「在用」', async () => {
  const brew: Installation = {
    id: '/opt/homebrew/Cellar/claude/2.1.280/bin/claude',
    realpath: '/opt/homebrew/Cellar/claude/2.1.280/bin/claude',
    pathEntry: '/opt/homebrew/bin/claude',
    isActive: true,
    manageable: false,
    provenance: { kind: 'homebrew', confidence: 'confirmed' },
    status: 'available',
    version: '2.1.280',
    latestVersion: null,
    updateAvailable: false,
  }
  installations.push(brew)
  vm.used = undefined
  mount()

  const local = page.getByTestId('source-row-local')
  await until('local is in the document', () => local.query() != null)
  expect((await local.element()).getAttribute('data-in-use')).toBe('true')
  // 说清是谁装的、在哪 —— 用户才知道为什么这一行没有更新和卸载。
  expect((await local.element()).textContent).toContain('Homebrew')
  expect((await local.element()).textContent).toContain('/opt/homebrew/bin/claude')
  expect((await page.getByTestId('source-row-managed').element()).getAttribute('data-in-use')).toBe('false')
  // 咕咕那份还没装:有一个「安装并切换」—— 从别处装的迁到咕咕管理就走这里。
  await until('source-managed-install is in the document', () => page.getByTestId('source-managed-install').query() != null)

  // 没设过自定义路径时「指定…」也点得开。❌ 曾经把按钮放在不可选的单选项里,单选项带
  // aria-disabled,按钮跟着被当成禁用 —— 真机取证时点不动。
  await userEvent.click(page.getByTestId('manual-override-open'))
  await until('manual-override-input is in the document', () => page.getByTestId('manual-override-input').query() != null)
})

function brewCopy(): Installation {
  return {
    id: '/opt/homebrew/Cellar/claude/2.1.280/bin/claude',
    realpath: '/opt/homebrew/Cellar/claude/2.1.280/bin/claude',
    pathEntry: '/opt/homebrew/bin/claude',
    isActive: true,
    manageable: false,
    provenance: { kind: 'homebrew', confidence: 'confirmed' },
    status: 'available',
    version: '2.1.280',
    latestVersion: null,
    updateAvailable: false,
  }
}

it('上次指定的自定义路径切走之后还在那一行里,点一下就切回去', async () => {
  installations.push(brewCopy(), manualInstall('cli', 'my-wrapper'))
  vm.used = { kind: 'auto' }
  mount()

  const custom = page.getByTestId('source-row-custom')
  await until('custom is in the document', () => custom.query() != null)
  expect((await custom.element()).getAttribute('data-in-use')).toBe('false')
  expect((await custom.element()).textContent).toContain('my-wrapper')

  await userEvent.click(page.getByTestId('source-row-custom').getByRole('radio'))
  expect(setUsedCalls.at(-1)).toEqual({ kind: 'cli', command: 'my-wrapper' })
})

it('面板开着时把咕咕那份卸掉:「在用」落回本机找到的,不是三行都空着', async () => {
  const managed: Installation = {
    id: '/gugu-home/agents/mise-bin/claude',
    realpath: '/gugu-home/agents/mise-bin/claude',
    pathEntry: null,
    isActive: false,
    manageable: true,
    provenance: { kind: 'mise', confidence: 'confirmed', ours: true },
    status: 'available',
    version: '2.1.281',
    latestVersion: null,
    updateAvailable: false,
  }
  installations.push(brewCopy(), managed)
  vm.used = { kind: 'method', method: 'mise' }
  mount()
  await until('source-row-managed has data-in-use=true', () => page.getByTestId('source-row-managed').query()?.getAttribute('data-in-use') === 'true')

  // 卸掉:副本少了一份,存下的选择还是「咕咕管理」(运行时据此落回自动嗅探)。
  installations.splice(installations.indexOf(managed), 1)
  // 真 app 里是数据层的变化触发重绘;这里换一个无关的 prop 逼它重绘,**保留**组件自己的状态。
  mount({ installDocs: 'https://example.com/docs' })

  // 重绘是异步的 —— 用会重试的断言等它落定。
  await until('source-row-managed has data-in-use=false', () => page.getByTestId('source-row-managed').query()?.getAttribute('data-in-use') === 'false')
  await until('source-row-local has data-in-use=true', () => page.getByTestId('source-row-local').query()?.getAttribute('data-in-use') === 'true')
})
