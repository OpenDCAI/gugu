// @vitest-environment jsdom
// #6264「从桌面用 SSH 一步装好」:设置 → 设备 → 添加一台机器。就地展开的一块:一个输入框 + 配置主机建议,
// 连上后原地变成进度(只画主进程推来的快照、回答 SSH 的提问);一行命令是另一种同等分量的装法(OneLineInstall)。
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
// 远程隧道暂不开放(packages/core/src/cloud/remoteTunnel.ts)。它那套界面留着等开放,下面带「远程隧道」的几条照旧守着它,
// 所以这里把开关做成可拨的、默认拨到「开」;关着时的样子单独一组(「远程隧道暂不开放」)。
const tunnel = vi.hoisted(() => ({ open: true }))
vi.mock('@gugu/core/cloud/remoteTunnel', () => ({
  get REMOTE_TUNNEL_OPEN() {
    return tunnel.open
  },
  SERVER_LOGIN_ACTION: '在咕咕桌面「设置 → 设备 → 添加一台机器」用远程 SSH 添加这台机器',
}))
import { AddServerPanel, LANDING_SLOW_MS } from '../../../../apps/desktop/src/components/settings/AddServerPanel'
import { DevicesSection } from '../../../../apps/desktop/src/components/settings/DevicesSection'
import { OneLineInstall } from '../../../../apps/desktop/src/components/settings/addServer/OneLineInstall'
import {
  filterSshConfigHosts,
  formatBytes,
  knownHostsRemoveCommand,
  landedDevice,
  lingerCommand,
  machineSummary,
  newlyAppearedDevices,
  progressText,
} from '../../../../apps/desktop/src/components/settings/addServer/addServerFormat'
import {
  SERVER_SSH_INSTALL_CHANNELS,
  type ServerSshInstallState,
} from '../../../../apps/desktop/src/lib/serverSshInstall'
import {
  handOverToSessionpage,
  HOST_OPEN_NEW_SESSION_KEY,
  installSessionpageNewSessionBridge,
  SESSIONPAGE_PENDING_NEW_SESSION_KEY,
  type NewSessionBridgeWindow,
} from '../../../../apps/desktop/src/lib/sessionpageNewSessionBridge'
import { DevicesContext, type DevicesContextValue } from '../../../../apps/desktop/src/store/devicesContext'
import { createReactHarness } from '../../../support/testHarness'
import zhSettings from '../../../../apps/desktop/src/i18n/locales/zh-CN/settings'
import enSettings from '../../../../apps/desktop/src/i18n/locales/en-US/settings'
import { zhCNSessionWorkflowMessages } from '../../../../apps/desktop/src/session/renderer/localization/messages-session-workflows'

const STEPS = ['connect', 'detect', 'download', 'service', 'login'] as const

function state(patch: Partial<ServerSshInstallState>): ServerSshInstallState {
  return {
    runId: 'run-1',
    target: 'alice@box:2222',
    steps: STEPS.map((id, i) => ({ id, status: i === 0 ? 'running' : 'pending' })),
    machine: null,
    prompt: null,
    warnings: [],
    failure: null,
    result: null,
    finished: false,
    log: [],
    ...patch,
  }
}

const steps = (statuses: Record<string, ServerSshInstallState['steps'][number]['status']>, extra: Record<string, object> = {}) =>
  STEPS.map((id) => ({ id, status: statuses[id] ?? 'pending', ...(extra[id] ?? {}) }))

function installApi(options: { hosts?: unknown[] } = {}) {
  let push: ((value: unknown) => void) | null = null
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === SERVER_SSH_INSTALL_CHANNELS.listHosts) return options.hosts ?? [{ alias: 'gpu', hostname: '10.0.0.9', user: 'alice' }]
    if (channel === SERVER_SSH_INSTALL_CHANNELS.info) {
      return { installCommand: 'curl -fsSL https://d/install.sh | sh', installCommandWget: 'wget -qO- https://d/install.sh | sh' }
    }
    if (channel === SERVER_SSH_INSTALL_CHANNELS.start) {
      const target = String((args[0] as { target?: string }).target ?? '')
      if (target === 'bad target') return { error: 'invalidTarget', problem: 'invalid' }
      if (target.includes('ProxyCommand')) return { error: 'invalidTarget', problem: 'unsupportedOption', option: 'ProxyCommand' }
      return { runId: 'run-1', state: state({}) }
    }
    return true
  })
  const eventOn = vi.fn((channel: string, cb: (value: unknown) => void) => {
    if (channel === SERVER_SSH_INSTALL_CHANNELS.state) push = cb
    return () => undefined
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { invoke, eventOn }
  return { invoke, emit: (s: ServerSshInstallState) => act(() => push?.(s)) }
}

const body = () => document.body.textContent ?? ''
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click())
const buttonNamed = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === name)
const buttonContaining = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(name))
const target = () => document.querySelector('[data-testid="add-server-target"]') as HTMLInputElement
const options = () => [...document.querySelectorAll('[data-testid="add-server-suggestions"] [role="option"]')]
async function key(el: Element, k: string) {
  await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) })
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function device(id: string, label: string, patch: Partial<Device> = {}): Device {
  return { device_id: id, label, is_online: true, platform: 'linux', hostname: 'box', capabilities: {}, ...patch } as unknown as Device
}

function withDevices(devices: Device[], rename = vi.fn(async () => undefined)) {
  const value: DevicesContextValue = {
    devices, loading: false, error: null, refresh: async () => {}, rename, remove: async () => {}, listBoundAgents: async () => [],
  }
  return (children: React.ReactNode) => <DevicesContext.Provider value={value}>{children}</DevicesContext.Provider>
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  delete (window as unknown as NewSessionBridgeWindow)[HOST_OPEN_NEW_SESSION_KEY]
})

const noop = () => undefined
const panel = (props: Partial<React.ComponentProps<typeof AddServerPanel>> = {}) => (
  <AddServerPanel method="ssh" onMethodChange={noop} onClose={noop} onAdded={noop} {...props} />
)
const inSettings = (key: string): string => {
  const read = (node: unknown, path: string[]): unknown => (path.length ? read((node as Record<string, unknown>)?.[path[0]], path.slice(1)) : node)
  return read(zhSettings, key.split('.')) as string
}

describe('AddServerPanel · 重新登录(#6264 设备行上的「重新登录」)', () => {
  it('展开就按这台桌面记着的那台机器开始(只递设备 id,❌ 目的地原串),地址框里是它的地址', async () => {
    const api = installApi()
    const harness = createReactHarness()
    await harness.render(panel({ relogin: { deviceId: 'dev-1', address: 'alice@box:2222' } }))
    await act(async () => undefined)
    const starts = api.invoke.mock.calls.filter(([channel]) => channel === SERVER_SSH_INSTALL_CHANNELS.start)
    expect(starts).toEqual([[SERVER_SSH_INSTALL_CHANNELS.start, { deviceId: 'dev-1' }]])
    harness.cleanup()
  })
})

describe('AddServerPanel · 一个输入框', () => {
  it('头上写明是「远程 SSH」+ 取消;没有名字框、没有标签页、配置主机不预先铺开;只有一个输入框 + 连接', async () => {
    installApi()
    const harness = createReactHarness()
    await harness.render(panel())
    await act(async () => undefined)
    expect(document.querySelector('[data-testid="add-server-nickname"]')).toBeNull()
    expect(document.querySelector('[role="tablist"]')).toBeNull()
    expect(document.querySelector('[data-testid="add-server-method-title"]')?.textContent).toBe('远程 SSH')
    expect(document.querySelectorAll('input')).toHaveLength(1)
    expect(target().placeholder).toBe('用户@主机、ssh 命令或 SSH 别名')
    expect(document.querySelector('[data-testid="add-server-suggestions"]')).toBeNull()
    expect(body()).not.toContain('gpu')
    expect(buttonNamed('取消')).toBeTruthy()
    expect(buttonNamed('连接')?.disabled).toBe(true)
    harness.cleanup()
  })

  it('打字时给匹配的配置主机(别名 / 主机名算,用户不算),第一条默认是当前项,↑↓ 选、回车直接连', async () => {
    const { invoke } = installApi({ hosts: [
      { alias: 'gpu', hostname: '10.0.0.9', user: 'alice' },
      { alias: 'gpu-2', hostname: '10.0.0.10', user: 'bob' },
      { alias: 'web', hostname: 'web.example' },
    ] })
    const harness = createReactHarness()
    await harness.render(panel())
    await act(async () => undefined)
    await type(target(), 'gp')
    expect(options().map((o) => o.textContent)).toEqual(['gpualice@10.0.0.9', 'gpu-2bob@10.0.0.10'])
    expect(target().getAttribute('aria-expanded')).toBe('true')
    expect(options()[0].getAttribute('aria-selected')).toBe('true')
    expect(options()[0].hasAttribute('data-highlighted')).toBe(true)
    expect(target().getAttribute('aria-activedescendant')).toBe(options()[0].id)
    await type(target(), 'BOB')
    expect(options()).toHaveLength(0)
    await type(target(), 'WEB.EX')
    expect(options().map((o) => o.textContent)).toEqual(['webweb.example'])
    await type(target(), 'gpu')
    await key(target(), 'ArrowDown')
    expect(options()[1].getAttribute('aria-selected')).toBe('true')
    await key(target(), 'ArrowUp')
    expect(options()[0].getAttribute('aria-selected')).toBe('true')
    await key(target(), 'Enter')
    expect(invoke).toHaveBeenCalledWith(SERVER_SSH_INSTALL_CHANNELS.start, { target: 'gpu' })
    expect(document.querySelector('[data-testid="add-server-progress"]')).toBeTruthy()
    harness.cleanup()
  })

  it('建议是「添加一台机器」同款菜单浮层:portal 出面板、同一张浮层、同一种行,最多露 5 行', async () => {
    installApi({ hosts: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((alias) => ({ alias, hostname: `${alias}.lan` })) })
    const harness = createReactHarness()
    await harness.render(panel())
    await act(async () => undefined)
    await type(target(), 'd')
    const list = document.querySelector('[data-testid="add-server-suggestions"]') as HTMLElement
    expect(options()).toHaveLength(6)
    // 不画在面板里:面板里后画的设备列表会盖上来。
    expect(document.querySelector('[data-testid="settings-add-server-panel"]')?.contains(list)).toBe(false)
    const surface = list.closest('.gg-menu') as HTMLElement
    expect(surface).toBeTruthy()
    expect(surface.getAttribute('data-slot')).toBe('popover-popup')
    // 5 × 36px 行 + 上下各 4px 内边距;间距走类名(与 Menu 的内联 4px / 6px 10px 逐值相同)。
    expect(list.classList.contains(`max-h-[${36 * 5 + 8}px]`)).toBe(true)
    expect(list.classList.contains('p-1')).toBe(true)
    for (const row of options()) {
      expect(row.classList.contains('gg-menu-item')).toBe(true)
      expect(row.classList.contains('px-[10px]')).toBe(true)
      expect(row.classList.contains('py-[6px]')).toBe(true)
      // 每行同一枚「服务器」图标不携带信息(design.md:❌ decorative icons),不画。
      expect(row.querySelector('svg')).toBeNull()
    }
    harness.cleanup()
  })

  it('↓ 在空输入框里列出全部;Esc 先收起建议;点一下建议也直接连', async () => {
    const { invoke } = installApi()
    const onClose = vi.fn()
    const harness = createReactHarness()
    await harness.render(panel({ onClose }))
    await act(async () => undefined)
    await key(target(), 'ArrowDown')
    expect(options()).toHaveLength(1)
    await key(target(), 'Escape')
    expect(options()).toHaveLength(0)
    expect(onClose).not.toHaveBeenCalled()
    await key(target(), 'Escape')
    expect(onClose).toHaveBeenCalled()
    await type(target(), 'g')
    await act(async () => { options()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
    expect(invoke).toHaveBeenCalledWith(SERVER_SSH_INSTALL_CHANNELS.start, { target: 'gpu' })
    harness.cleanup()
  })

  it('地址看不懂、带了不接的选项时当场说', async () => {
    installApi()
    const harness = createReactHarness()
    await harness.render(panel())
    await type(target(), 'bad target')
    await click(buttonNamed('连接'))
    expect(body()).toContain('无法识别地址')
    await type(target(), 'ssh -o ProxyCommand=x box')
    await click(buttonNamed('连接'))
    expect(body()).toContain('不支持 ssh 选项「ProxyCommand」')
    harness.cleanup()
  })
})

describe('AddServerPanel · 连接后原地变成进度', () => {
  it('五步、系统识别、下载进度、指纹确认、密码提问(遮挡切换 + 大写锁定 + 重试提示)照快照画', async () => {
    const { invoke, emit } = installApi()
    const harness = createReactHarness()
    await harness.render(panel())
    await act(async () => undefined)
    await type(target(), 'gpu')
    await click(buttonNamed('连接'))
    expect(invoke).toHaveBeenCalledWith(SERVER_SSH_INSTALL_CHANNELS.start, { target: 'gpu' })
    expect(body()).toContain('正在添加 alice@box:2222')
    expect(body()).toContain('识别系统')

    emit(state({ prompt: { id: 'p2', kind: 'hostKey', message: 'x', hostKey: { host: '[box]:2222', keyType: 'ED25519', fingerprint: 'SHA256:abc' } } }))
    expect(document.querySelector('[data-testid="add-server-fingerprint"]')?.textContent).toBe('SHA256:abc')
    await click(buttonNamed('信任并继续'))
    expect(invoke).toHaveBeenCalledWith(SERVER_SSH_INSTALL_CHANNELS.answer, { runId: 'run-1', promptId: 'p2', value: 'yes' })

    emit(state({ prompt: { id: 'p1', kind: 'password', subject: 'alice@box', message: "alice@box's password: ", retry: true } }))
    expect(body()).toContain('输入 alice@box 的 SSH 密码')
    expect(body()).toContain('密码错误，请重试。')
    const password = document.querySelector('[data-testid="add-server-secret"]') as HTMLInputElement
    expect(password.type).toBe('password')
    await act(async () => {
      password.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', bubbles: true, modifierCapsLock: true } as KeyboardEventInit))
    })
    expect(body()).toContain('大写锁定已打开。')
    await click(document.querySelector('button[aria-label="显示"]'))
    expect((document.querySelector('[data-testid="add-server-secret"]') as HTMLInputElement).type).toBe('text')
    await type(document.querySelector('[data-testid="add-server-secret"]') as HTMLInputElement, 'hunter2')
    await click(buttonNamed('继续'))
    expect(invoke).toHaveBeenCalledWith(SERVER_SSH_INSTALL_CHANNELS.answer, { runId: 'run-1', promptId: 'p1', value: 'hunter2' })

    emit(state({
      steps: steps({ connect: 'done', detect: 'done', download: 'running' }, { download: { version: '0.2.99', via: 'desktop', progress: { phase: 'upload', done: 52428800, total: 104857600 } } }),
      machine: { os: 'Linux', arch: 'aarch64', distro: 'Ubuntu 22.04.4 LTS', libc: 'glibc 2.35', hostname: 'box', user: 'alice', installedVersion: null, others: ['colleague@lab.edu'], alreadySignedIn: false },
      log: ['Authenticated to box', '正在下载咕咕 server 0.2.99 …'],
    }))
    expect(body()).toContain('Ubuntu 22.04.4 LTS · arm64 · glibc 2.35')
    expect(body()).toContain('版本 0.2.99 · 正在传到那台机器 50.0 MB / 100 MB · 50%')
    expect(body()).toContain('改由这台电脑传过去')
    expect(body()).toContain('添加你的账号（已登录：colleague@lab.edu）')
    expect(document.querySelector('progress')?.getAttribute('value')).toBe('52428800')
    await click(buttonContaining('查看详情'))
    expect(document.querySelector('[data-testid="add-server-log"]')?.textContent).toContain('Authenticated to box')
    harness.cleanup()
  })

  it('失败:说清卡在哪一步、为什么、下一步;指纹变了给出删旧记录的命令;装了一半如实说;改地址回到输入框', async () => {
    const { emit } = installApi()
    const harness = createReactHarness()
    await harness.render(panel())
    await act(async () => undefined)
    await type(target(), 'gpu')
    await click(buttonNamed('连接'))
    emit(state({
      steps: steps({ connect: 'failed' }),
      failure: { step: 'connect', reason: 'hostKeyChanged', hostKey: { host: '[box]:2222', fingerprint: 'SHA256:new' } },
      finished: true,
    }))
    expect(body()).toContain('卡在「连接」')
    expect(body()).toContain('这台机器的身份变了')
    expect(body()).toContain("ssh-keygen -R '[box]:2222'")
    expect(body()).toContain('SHA256:new')
    expect(buttonNamed('重试')).toBeTruthy()

    emit(state({
      steps: steps({ connect: 'done', detect: 'done', download: 'done', service: 'done', login: 'failed' }),
      failure: { step: 'login', reason: 'cancelled', leftover: 'running' },
      finished: true,
    }))
    expect(body()).toContain('已取消。')
    expect(body()).not.toContain('卡在「登录你的账号」')
    expect(body()).toContain('已在运行，尚未登录。重试会从这里继续。')
    await click(buttonNamed('改地址'))
    expect(target().value).toBe('gpu')
    harness.cleanup()
  })

  it('#6264「下次免密」:还在装时它上线了也不收起;装好了才收;没做成就留着说清为什么', async () => {
    const { emit } = installApi()
    const onAdded = vi.fn()
    const harness = createReactHarness()
    await harness.render(withDevices([device('mine', '本机')])(panel({ onAdded })))
    await act(async () => undefined)
    await type(target(), 'gpu')
    await click(buttonNamed('连接'))
    const done = {
      steps: steps({ connect: 'done', detect: 'done', download: 'done', service: 'done', login: 'done' }),
      result: { email: 'me@x.y', others: [], hostname: 'box', userId: 'u-1', deviceId: 'dev-1', alreadySignedIn: false },
      finished: true,
    }
    emit(state({ ...done, keyInstall: { status: 'working' } }))
    await harness.render(withDevices([device('mine', '本机'), device('dev-1', 'Linux 1')])(panel({ onAdded })))
    await act(async () => undefined)
    expect(onAdded).not.toHaveBeenCalled()
    expect(body()).toContain(inSettings('devices.addServer.keyInstall.working'))
    emit(state({ ...done, keyInstall: { status: 'failed', reason: 'not-accepted' } }))
    await act(async () => undefined)
    expect(onAdded).not.toHaveBeenCalled()
    const failed = document.querySelector('[data-testid="add-server-key-install"][data-status="failed"]')
    expect(failed?.textContent).toContain('未能设好免密')
    expect(failed?.textContent).toContain(inSettings('devices.addServer.keyInstall.reasons.not-accepted'))
    emit(state({ ...done, keyInstall: { status: 'installed' } }))
    await act(async () => undefined)
    expect(onAdded).toHaveBeenCalledTimes(1)
    harness.cleanup()
  })

  it('答密码时勾了「以后不用再输密码」:回答带上 installKey', async () => {
    const { invoke, emit } = installApi()
    const harness = createReactHarness()
    await harness.render(withDevices([device('mine', '本机')])(panel()))
    await act(async () => undefined)
    await type(target(), 'gpu')
    await click(buttonNamed('连接'))
    emit(state({ prompt: { id: 'p1', kind: 'password', message: "alice@box's password:", subject: 'alice@box', offerKeyInstall: true } }))
    await act(async () => undefined)
    await click(document.querySelector('[data-testid="ssh-prompt-install-key"]'))
    await type(document.querySelector('[data-testid="add-server-secret"]') as HTMLInputElement, 'pw')
    await click(buttonNamed('继续'))
    expect(invoke).toHaveBeenCalledWith(SERVER_SSH_INSTALL_CHANNELS.answer, { runId: 'run-1', promptId: 'p1', value: 'pw', installKey: true })
    harness.cleanup()
  })

  it('装好且没有提醒:先就地等它上线(列表里还没有它时 ❌ 收起),它一出现在列表里就收起;从配置里挑的新机器默认叫那个别名', async () => {
    const { emit } = installApi()
    const onAdded = vi.fn()
    const harness = createReactHarness()
    await harness.render(withDevices([device('mine', '本机')])(panel({ onAdded })))
    await act(async () => undefined)
    await type(target(), 'gpu')
    await click(buttonNamed('连接'))
    emit(state({
      steps: steps({ connect: 'done', detect: 'done', download: 'done', service: 'done', login: 'done' }),
      result: { email: 'me@x.y', others: [], hostname: 'box', userId: 'u-1', deviceId: 'dev-1', alreadySignedIn: false },
      finished: true,
    }))
    await act(async () => undefined)
    // 登录成功到第一下心跳之间(实测约 6 秒)设备行还不存在:这块留着、说在等。
    expect(onAdded).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="add-server-landing"]')?.getAttribute('data-landing')).toBe('waiting')
    expect(body()).toContain('等待上线…')
    expect(document.querySelector('[data-testid="add-server-new-session"]')).toBeNull()
    // 它出现了,但还离线:仍然等。
    await harness.render(withDevices([device('mine', '本机'), device('dev-1', 'Linux 1', { is_online: false })])(panel({ onAdded })))
    await act(async () => undefined)
    expect(onAdded).not.toHaveBeenCalled()
    // 上线了:当场收起。
    await harness.render(withDevices([device('mine', '本机'), device('dev-1', 'Linux 1')])(panel({ onAdded })))
    await act(async () => undefined)
    expect(onAdded).toHaveBeenCalledTimes(1)
    expect(onAdded).toHaveBeenCalledWith({ deviceId: 'dev-1', name: 'gpu' })
    harness.cleanup()
  })

  it('等了挺久还没上线:改口说还没上线、可以先点「完成」', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { emit } = installApi()
      const onAdded = vi.fn()
      const harness = createReactHarness()
      await harness.render(withDevices([device('mine', '本机')])(panel({ onAdded })))
      await act(async () => undefined)
      await type(target(), 'alice@10.0.0.9')
      await click(buttonNamed('连接'))
      emit(state({
        steps: steps({ connect: 'done', detect: 'done', download: 'done', service: 'done', login: 'done' }),
        result: { email: 'me@x.y', others: [], hostname: 'box', userId: 'u-1', deviceId: 'dev-1', alreadySignedIn: false },
        finished: true,
      }))
      await act(async () => undefined)
      await act(async () => { vi.advanceTimersByTime(LANDING_SLOW_MS) })
      expect(document.querySelector('[data-testid="add-server-landing"]')?.getAttribute('data-landing')).toBe('slow')
      expect(body()).toContain('尚未上线。可先点「完成」')
      await click(buttonNamed('完成'))
      expect(onAdded).toHaveBeenCalledWith({ deviceId: 'dev-1', name: null })
      harness.cleanup()
    } finally {
      vi.useRealTimers()
    }
  })

  it('装的时候没解析出设备 id:认展开之后新出现、且在线的那一台', async () => {
    const { emit } = installApi()
    const onAdded = vi.fn()
    const harness = createReactHarness()
    await harness.render(withDevices([device('mine', '本机')])(panel({ onAdded })))
    await act(async () => undefined)
    await type(target(), 'gpu')
    await click(buttonNamed('连接'))
    emit(state({
      steps: steps({ connect: 'done', detect: 'done', download: 'done', service: 'done', login: 'done' }),
      result: { email: 'me@x.y', others: [], hostname: 'box', userId: 'u-1', deviceId: null, alreadySignedIn: false },
      finished: true,
    }))
    await act(async () => undefined)
    expect(onAdded).not.toHaveBeenCalled()
    await harness.render(withDevices([device('mine', '本机'), device('dev-9', 'Linux 1')])(panel({ onAdded })))
    await act(async () => undefined)
    expect(onAdded).toHaveBeenCalledWith({ deviceId: 'dev-9', name: 'gpu' })
    harness.cleanup()
  })

  it('填的是地址、或重新接上的老机器:不改名', async () => {
    const { emit } = installApi()
    const onAdded = vi.fn()
    const harness = createReactHarness()
    await harness.render(withDevices([device('dev-old', 'Linux 1')])(panel({ onAdded })))
    await act(async () => undefined)
    await type(target(), 'alice@10.0.0.9')
    await click(buttonNamed('连接'))
    emit(state({
      steps: steps({ connect: 'done', detect: 'done', download: 'done', service: 'done', login: 'done' }),
      result: { email: 'me@x.y', others: [], hostname: 'box', userId: 'u-1', deviceId: 'dev-new', alreadySignedIn: false },
      finished: true,
    }))
    await act(async () => undefined)
    await harness.render(withDevices([device('dev-old', 'Linux 1'), device('dev-new', 'Linux 2')])(panel({ onAdded })))
    await act(async () => undefined)
    expect(onAdded).toHaveBeenLastCalledWith({ deviceId: 'dev-new', name: null })
    harness.cleanup()
  })

  it('装好但有提醒(linger):留着让人看完,可复制命令;「完成」才收起;「在这台机器上新建任务」', async () => {
    const { emit } = installApi()
    const openOnDevice = vi.fn()
    ;(window as unknown as NewSessionBridgeWindow)[HOST_OPEN_NEW_SESSION_KEY] = openOnDevice
    const onAdded = vi.fn()
    const harness = createReactHarness()
    await harness.render(withDevices([])(panel({ onAdded })))
    await act(async () => undefined)
    await type(target(), 'gpu')
    await click(buttonNamed('连接'))
    await harness.render(withDevices([device('dev-1', 'Linux 1')])(panel({ onAdded })))
    await act(async () => undefined)
    emit(state({
      steps: steps({ connect: 'done', detect: 'done', download: 'skipped', service: 'done', login: 'done' }, { download: { skippedBecause: 'alreadyInstalled', version: '0.2.50' } }),
      warnings: [{ kind: 'lingerMissing', user: 'alice' }],
      result: { email: 'me@x.y', others: ['colleague@lab.edu'], hostname: 'box', userId: 'u-1', deviceId: 'dev-1', alreadySignedIn: false },
      finished: true,
    }))
    await act(async () => undefined)
    expect(onAdded).not.toHaveBeenCalled()
    expect(body()).toContain('已经装过 · 版本 0.2.50')
    expect(body()).toContain('sudo loginctl enable-linger alice')
    expect(body()).toContain('box 已登录 me@x.y')
    expect(body()).toContain('已上线。')
    expect(body()).toContain('colleague@lab.edu')
    await click(document.querySelector('[data-testid="add-server-new-session"]'))
    expect(onAdded).toHaveBeenCalledWith({ deviceId: 'dev-1', name: 'gpu' })
    expect(openOnDevice).toHaveBeenCalledWith('dev-1')
    harness.cleanup()
  })
})

describe('OneLineInstall · 一行命令添加', () => {
  it('那一行 + 复制(可切 wget)、短码时效与过期怎么办;等上线,机器一上线就翻成「已添加」', async () => {
    installApi()
    const onAdded = vi.fn()
    const harness = createReactHarness()
    const view = (devices: Device[]) => withDevices(devices)(<OneLineInstall onAdded={onAdded} />)
    await harness.render(view([device('mine', '本机')]))
    await act(async () => undefined)
    expect(document.querySelector('[data-testid="add-server-install-command"]')?.textContent).toContain('curl -fsSL https://d/install.sh | sh')
    expect(buttonNamed('复制')).toBeTruthy()
    await click(buttonContaining('用 wget'))
    expect(document.querySelector('[data-testid="add-server-install-command"]')?.textContent).toContain('wget -qO- https://d/install.sh | sh')
    expect(body()).toContain('短码 15 分钟内有效')
    const status = () => document.querySelector('[data-testid="add-server-one-line-status"]')?.textContent
    expect(status()).toBe('等待机器上线…')

    // 新机器注册了但还没在线:照样等。
    await harness.render(view([device('mine', '本机'), device('new-1', 'Linux 2', { is_online: false })]))
    expect(status()).toBe('等待机器上线…')
    await harness.render(view([device('mine', '本机'), device('new-1', 'Linux 2')]))
    expect(status()).toBe('Linux 2 已添加')
    await click(buttonNamed('完成'))
    expect(onAdded).toHaveBeenCalledWith('new-1')
    harness.cleanup()
  })
})

describe('AddServerPanel · 连不上时改用远程隧道', () => {
  it('网络到不了(非认证):原因那句话里有一段「改用远程隧道」,点了换成远程隧道;认证失败不给', async () => {
    const { emit } = installApi()
    const onMethodChange = vi.fn()
    const harness = createReactHarness()
    await harness.render(panel({ onMethodChange }))
    await act(async () => undefined)
    await type(target(), 'gpu')
    await click(buttonNamed('连接'))
    emit(state({ steps: steps({ connect: 'failed' }), failure: { step: 'connect', reason: 'unreachable' }, finished: true }))
    const link = document.querySelector('[data-testid="add-server-switch-to-tunnel"]')
    expect(link?.textContent).toBe('改用远程隧道')
    // 是那句话的一部分,❌ 底下另起一颗按钮。
    expect(link?.parentElement?.textContent).toContain('无法访问这台机器')
    await click(link)
    expect(onMethodChange).toHaveBeenCalledWith('tunnel')
    harness.cleanup()
  })

  it('认证失败、指纹变了:不给「改用远程隧道」', async () => {
    const { emit } = installApi()
    const harness = createReactHarness()
    await harness.render(panel())
    await act(async () => undefined)
    await type(target(), 'gpu')
    await click(buttonNamed('连接'))
    emit(state({ steps: steps({ connect: 'failed' }), failure: { step: 'connect', reason: 'authFailed' }, finished: true }))
    expect(body()).toContain('SSH 登录被拒绝')
    expect(document.querySelector('[data-testid="add-server-switch-to-tunnel"]')).toBeNull()
    harness.cleanup()
  })

  it('远程隧道那块:头上写「远程隧道」,正文是那一行命令', async () => {
    installApi()
    const harness = createReactHarness()
    await harness.render(withDevices([])(panel({ method: 'tunnel' })))
    await act(async () => undefined)
    expect(document.querySelector('[data-testid="add-server-method-title"]')?.textContent).toBe('远程隧道')
    expect(document.querySelector('[data-testid="add-server-one-line"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="add-server-target"]')).toBeNull()
    harness.cleanup()
  })
})

/**
 * 打开「添加一台机器」菜单,**等它开完**再返回。Base UI 菜单的开场(撤掉 `data-starting-style`、焦点移进第一项)
 * 挂在下一帧上;只 flush 一次 act 的话,那一帧有没有落进来取决于 jsdom 帧节拍与前面跑了多少用例 ——
 * 整文件跑时没落进来,紧接着的 Esc 按在半开的菜单上,被开场剩下的那半截盖掉,菜单又开回来(#6550)。
 */
async function openAddMenu() {
  const trigger = document.querySelector<HTMLElement>('[data-testid="settings-add-server-button"]')!
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    trigger.click()
  })
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
  // 开场没走完就别往下测 —— 否则又是一条时红时绿的用例。
  expect(document.querySelector('[role="menu"][data-starting-style]')).toBeNull()
}
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')]

describe('远程隧道暂不开放(当前默认)', () => {
  afterEach(() => {
    tunnel.open = true
  })

  it('「添加一台机器」直接展开远程 SSH,❌ 弹一个只有一项的菜单', async () => {
    tunnel.open = false
    installApi()
    const harness = createReactHarness()
    await harness.render(withDevices([device('mine', 'MacBook', { is_current_device: true })])(<DevicesSection />))
    await act(async () => undefined)
    await click(document.querySelector('[data-testid="settings-add-server-button"]'))
    expect(menuItems()).toHaveLength(0)
    expect(document.querySelector('[data-testid="settings-add-server-panel"]')?.getAttribute('data-method')).toBe('ssh')
    harness.cleanup()
  })

  it('SSH 网络到不了:照常说原因,❌ 指去远程隧道', async () => {
    tunnel.open = false
    const { emit } = installApi()
    const harness = createReactHarness()
    await harness.render(panel({ onMethodChange: vi.fn() }))
    await act(async () => undefined)
    await type(target(), 'gpu')
    await click(buttonNamed('连接'))
    emit(state({ steps: steps({ connect: 'failed' }), failure: { step: 'connect', reason: 'unreachable' }, finished: true }))
    expect(document.body.textContent).toContain('无法访问这台机器')
    expect(document.querySelector('[data-testid="add-server-switch-to-tunnel"]')).toBeNull()
    harness.cleanup()
  })
})

describe('DevicesSection · 添加一台机器', () => {
  it('按钮打开一个两项的菜单:先「远程 SSH」再「远程隧道」,各带一句说明;挑哪个就展开哪一块(同时只一块)', async () => {
    installApi()
    const harness = createReactHarness()
    await harness.render(withDevices([device('mine', 'MacBook', { is_current_device: true })])(<DevicesSection />))
    await act(async () => undefined)
    await openAddMenu()
    const items = menuItems()
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toBe('远程 SSH经 SSH 安装，终端和文件直连')
    expect(items[1].textContent).toBe('远程隧道在那台机器上运行一行命令，经咕咕云连接')
    await click(document.querySelector('[data-testid="settings-add-server-tunnel"]'))
    expect(document.querySelectorAll('[data-testid="settings-add-server-panel"]')).toHaveLength(1)
    expect(document.querySelector('[data-testid="settings-add-server-panel"]')?.getAttribute('data-method')).toBe('tunnel')
    await click(document.querySelector('[data-testid="add-server-close"]'))
    expect(document.querySelector('[data-testid="settings-add-server-panel"]')).toBeNull()
    await openAddMenu()
    await click(document.querySelector('[data-testid="settings-add-server-ssh"]'))
    expect(document.querySelector('[data-testid="settings-add-server-panel"]')?.getAttribute('data-method')).toBe('ssh')
    harness.cleanup()
  })

  it('SSH 连不上 → 点「改用远程隧道」,同一块换成远程隧道', async () => {
    const { emit } = installApi()
    const harness = createReactHarness()
    await harness.render(withDevices([device('mine', 'MacBook', { is_current_device: true })])(<DevicesSection />))
    await act(async () => undefined)
    await openAddMenu()
    await click(document.querySelector('[data-testid="settings-add-server-ssh"]'))
    await type(target(), 'gpu')
    await click(buttonNamed('连接'))
    emit(state({ steps: steps({ connect: 'failed' }), failure: { step: 'connect', reason: 'connectTimeout' }, finished: true }))
    await click(document.querySelector('[data-testid="add-server-switch-to-tunnel"]'))
    expect(document.querySelector('[data-testid="settings-add-server-panel"]')?.getAttribute('data-method')).toBe('tunnel')
    expect(document.querySelector('[data-testid="add-server-one-line"]')).toBeTruthy()
    harness.cleanup()
  })

  it('叫法一致:菜单、面板头、设备行、任务页的说明都用「远程 SSH / 远程隧道」', () => {
    expect(inSettings('devices.addServer.method.ssh')).toBe('远程 SSH')
    expect(inSettings('devices.addServer.method.tunnel')).toBe('远程隧道')
    expect(inSettings('devices.via.ssh').startsWith('远程 SSH：')).toBe(true)
    expect(inSettings('devices.via.tunnel')).toBe('远程隧道')
    expect(inSettings('devices.addServer.switchToTunnel')).toContain('远程隧道')
    expect(inSettings('devices.via.cloud')).toBeUndefined()
    expect(inSettings('devices.via.sshElsewhere')).toBe('远程 SSH')
    // 没有终端直连的机器既可能是远程隧道的,也可能是别的电脑用远程 SSH 加的:说法两种都成立,❌ 只说「远程隧道」。
    for (const key of ['task.deviceHintGeneralOnly', 'taskConfig.sessionViewRemoteNeedsSsh'] as const) {
      expect(zhCNSessionWorkflowMessages[key]).not.toContain('远程隧道')
      expect(zhCNSessionWorkflowMessages[key]).toContain('远程 SSH')
    }
    expect(enSettings.devices.addServer.method.ssh).toBe('Remote SSH')
    expect(enSettings.devices.addServer.method.tunnel).toBe('Remote tunnel')
  })

  it('别的电脑用远程 SSH 加的机器:就是一行普通的机器,标「远程 SSH」;❌「其他电脑上添加的」收起栏(owner 2026-10-08 选 B)', async () => {
    installApi()
    const harness = createReactHarness()
    const d22 = device('d22', 'd22', { capabilities: { host_kind: 'server', connect_via: 'ssh' } as unknown as Device['capabilities'] })
    await harness.render(withDevices([device('mine', 'MacBook', { is_current_device: true }), d22])(<DevicesSection />))
    await act(async () => undefined)
    const row = document.querySelector('[data-device-id="d22"]')
    expect(row).toBeTruthy()
    expect(row?.textContent).toContain('远程 SSH')
    expect(row?.textContent).not.toContain('远程隧道')
    expect(document.querySelector('[data-testid="settings-devices-elsewhere"]')).toBeNull()
    harness.cleanup()
  })

  it('装好收起,新机器出现后改成别名', async () => {
    const { emit } = installApi()
    const rename = vi.fn(async () => undefined)
    const harness = createReactHarness()
    await harness.render(withDevices([device('mine', 'MacBook', { is_current_device: true })], rename)(<DevicesSection />))
    await act(async () => undefined)
    await openAddMenu()
    await click(document.querySelector('[data-testid="settings-add-server-ssh"]'))
    const panelEl = document.querySelector('[data-testid="settings-add-server-panel"]')
    expect(panelEl).toBeTruthy()
    expect(panelEl?.closest('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[data-testid="settings-add-server-button"]')).toBeNull()
    await type(target(), 'gpu')
    await click(buttonNamed('连接'))
    emit(state({
      steps: steps({ connect: 'done', detect: 'done', download: 'done', service: 'done', login: 'done' }),
      result: { email: 'me@x.y', others: [], hostname: 'box', userId: 'u-1', deviceId: 'dev-1', alreadySignedIn: false },
      finished: true,
    }))
    await act(async () => undefined)
    // 还没出现在列表里:这块留着说在等,❌ 收起后留一张没有它的列表。
    expect(document.querySelector('[data-testid="settings-add-server-panel"]')).toBeTruthy()
    expect(rename).not.toHaveBeenCalled()
    await harness.render(withDevices([device('mine', 'MacBook', { is_current_device: true }), device('dev-1', 'Linux 1')], rename)(<DevicesSection />))
    await act(async () => undefined)
    expect(document.querySelector('[data-testid="settings-add-server-panel"]')).toBeNull()
    expect(rename).toHaveBeenCalledWith('dev-1', 'gpu')
    harness.cleanup()
  })
})

describe('addServerFormat', () => {
  it('字节、进度、系统摘要', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(110443427)).toBe('105 MB')
    expect(progressText({ phase: 'download', done: 1048576, total: 4194304 })).toBe('1.0 MB / 4.0 MB · 25%')
    expect(progressText({ phase: 'download', done: 1048576, total: null })).toBe('1.0 MB')
    expect(machineSummary({ os: 'Linux', distro: '', arch: 'x86_64', libc: 'glibc 2.31' })).toBe('Linux · x64 · glibc 2.31')
    expect(machineSummary({ os: 'Darwin', distro: 'macOS 14.5', arch: 'arm64', libc: '' })).toBe('macOS 14.5 · arm64')
  })

  it('要复制给别人执行的命令都引好号(zsh 会把 [ ] 当通配)', () => {
    expect(knownHostsRemoveCommand('[10.0.0.5]:2222')).toBe("ssh-keygen -R '[10.0.0.5]:2222'")
    expect(knownHostsRemoveCommand('box.example.com')).toBe('ssh-keygen -R box.example.com')
    expect(lingerCommand('alice')).toBe('sudo loginctl enable-linger alice')
  })

  it('装好之后「出现了」的判据:知道 id 只认那一台且在线;不知道 id 认新出现且在线的', () => {
    const before = new Set(['mine'])
    expect(landedDevice('dev-1', before, [device('mine', 'a')])).toBeNull()
    expect(landedDevice('dev-1', before, [device('dev-1', 'b', { is_online: false })])).toBeNull()
    expect(landedDevice('dev-1', before, [device('dev-2', 'c'), device('dev-1', 'b')])?.device_id).toBe('dev-1')
    // 重新接上的老机器(展开前就在)也算出现了。
    expect(landedDevice('mine', before, [device('mine', 'a')])?.device_id).toBe('mine')
    expect(landedDevice(null, before, [device('mine', 'a')])).toBeNull()
    expect(landedDevice(null, before, [device('mine', 'a'), device('dev-3', 'd')])?.device_id).toBe('dev-3')
  })

  it('配置主机建议与新出现(且在线)的机器', () => {
    const hosts = [{ alias: 'gpu', hostname: '10.0.0.9', user: 'alice' }, { alias: 'web', hostname: 'web.example' }]
    // 用户名不算:打「d」不该因为用户叫 administrator 就列出 bastion。
    expect(filterSshConfigHosts(hosts, 'ALICE')).toEqual([])
    expect(filterSshConfigHosts([{ alias: 'bastion', hostname: '1.2.3.4', user: 'administrator' }], 'd')).toEqual([])
    expect(filterSshConfigHosts(hosts, 'WEB.EX').map((h) => h.alias)).toEqual(['web'])
    expect(filterSshConfigHosts(hosts, '  ')).toHaveLength(2)
    // 开头对上的在前,中间含有的在后;同一档保持配置里的先后。
    const ranked = [
      { alias: 'prod-db' }, { alias: 'dmit-ls' }, { alias: 'edge', hostname: 'd15.example' }, { alias: 'sandbox' }, { alias: 'd22' },
    ]
    expect(filterSshConfigHosts(ranked, 'd').map((h) => h.alias)).toEqual(['dmit-ls', 'edge', 'd22', 'prod-db', 'sandbox'])
    expect(newlyAppearedDevices(new Set(['a']), [device('a', 'A'), device('cloud:u', 'Cloud'), device('b', 'B'), device('c', 'C', { is_online: false })]).map((d) => d.device_id)).toEqual(['b'])
  })
})

describe('taskpageNewSessionBridge', () => {
  it('任务页在:直接交过去;不在:先存着,任务页挂桥时补上', () => {
    const w: NewSessionBridgeWindow = {}
    handOverToSessionpage(w, 'dev-1')
    expect(w[SESSIONPAGE_PENDING_NEW_SESSION_KEY]).toBe('dev-1')
    const opened: string[] = []
    installSessionpageNewSessionBridge(w, (id) => opened.push(id))
    expect(opened).toEqual(['dev-1'])
    expect(w[SESSIONPAGE_PENDING_NEW_SESSION_KEY]).toBeUndefined()
    handOverToSessionpage(w, 'dev-2')
    expect(opened).toEqual(['dev-1', 'dev-2'])
  })
})

describe('#6264 机器上限:平时不披露,碰到了就地停下说清楚', () => {
  it('远程 SSH 登录那一步被上限拒:说清哪条上限、用了几台,句尾「升级会员」「移除一台机器」是句子里的强调色文字', async () => {
    const { emit } = installApi()
    const onUpgrade = vi.fn()
    const onClose = vi.fn()
    const harness = createReactHarness()
    await harness.render(panel({ onUpgrade, onClose }))
    await act(async () => undefined)
    await type(target(), 'gpu')
    await click(buttonNamed('连接'))
    emit(state({
      steps: steps({ connect: 'done', detect: 'done', download: 'done', service: 'done', login: 'failed' }),
      failure: { step: 'login', reason: 'machineLimit', machineLimit: { limit: 'total', used: 10, max: 10 } },
      finished: true,
    }))
    const notice = document.querySelector('[data-testid="add-server-machine-limit"]')
    expect(notice?.textContent).toBe('咕咕 server 已达上限（10/10），未添加。 升级会员，或移除一台机器。')
    // 上限不是网络问题:不给「改用远程隧道」。
    expect(document.querySelector('[data-testid="add-server-switch-to-tunnel"]')).toBeNull()
    await click(document.querySelector('[data-testid="add-server-machine-limit-upgrade"]'))
    expect(onUpgrade).toHaveBeenCalledTimes(1)
    await click(document.querySelector('[data-testid="add-server-machine-limit-remove"]'))
    expect(onClose).toHaveBeenCalledTimes(1)
    harness.cleanup()
  })

  it('远程隧道:没碰到上限时一个数字都不露;那台机器因为上限没登上 ⇒ 停止转圈,就地说清楚', async () => {
    installApi()
    const onUpgrade = vi.fn()
    const onRemoveMachine = vi.fn()
    let answer: { limit: 'tunnel'; used: number; max: number; hostname: string | null } | null = null
    const recentMachineLimitRefusal = vi.fn(async () => answer)
    const value: DevicesContextValue = {
      devices: [device('mine', '本机')], loading: false, error: null, refresh: async () => {}, rename: async () => {},
      remove: async () => {}, listBoundAgents: async () => [], recentMachineLimitRefusal,
    }
    const harness = createReactHarness()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await harness.render(
        <DevicesContext.Provider value={value}>
          <OneLineInstall onAdded={noop} onUpgrade={onUpgrade} onRemoveMachine={onRemoveMachine} />
        </DevicesContext.Provider>,
      )
      await act(async () => undefined)
      const status = () => document.querySelector('[data-testid="add-server-one-line-status"]')?.textContent
      expect(status()).toBe('等待机器上线…')
      expect(body()).not.toMatch(/\d+ 台/)
      expect(recentMachineLimitRefusal).toHaveBeenCalledTimes(1)

      answer = { limit: 'tunnel', used: 3, max: 3, hostname: 'gpu-9' }
      await act(async () => { vi.advanceTimersByTime(5_000) })
      await act(async () => undefined)
      expect(status()).toContain('远程隧道已达上限（3/3），未添加。')
      expect(status()).toContain('远程 SSH 不占名额')
      expect(status()).not.toContain('等待机器上线')
      await click(document.querySelector('[data-testid="add-server-machine-limit-upgrade"]'))
      expect(onUpgrade).toHaveBeenCalledTimes(1)
      // 停下之后不再问。
      const calls = recentMachineLimitRefusal.mock.calls.length
      await act(async () => { vi.advanceTimersByTime(20_000) })
      expect(recentMachineLimitRefusal.mock.calls.length).toBe(calls)
    } finally {
      vi.useRealTimers()
      harness.cleanup()
    }
  })

  it('中英文案齐全', () => {
    for (const locale of [zhSettings, enSettings]) {
      const limit = (locale as unknown as { devices: { addServer: { machineLimit: Record<string, string>; reasons: Record<string, string> } } }).devices.addServer
      expect(Object.keys(limit.machineLimit).sort()).toEqual(['end', 'or', 'remove', 'total', 'tunnel', 'unknown', 'upgrade'])
      expect(limit.reasons.machineLimit).toBeTruthy()
    }
  })
})

// 2026-09-24 实测:设置 → 设备 →「添加一台机器」→「远程 SSH」,展开的那块输入框没有焦点;
// 菜单关上时按钮已卸掉,焦点被还到了设置窗口背后会话页的输入框,接着打的 ssh 命令在背后开了一条真会话。
describe('DevicesSection · 挑了装法,焦点进那一块', () => {
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  function focusedComposerBehind() {
    // 设置窗口背后的会话页输入框:打开菜单之前焦点在它上面,Base UI 会把它记成「上一个焦点」。
    const composer = document.createElement('textarea')
    composer.setAttribute('data-testid', 'composer-behind')
    document.body.appendChild(composer)
    composer.focus()
    return composer
  }

  it('远程 SSH:焦点落在地址输入框上,❌ 回到背后的输入框或 body', async () => {
    installApi()
    const composer = focusedComposerBehind()
    const harness = createReactHarness()
    await harness.render(withDevices([device('mine', 'MacBook', { is_current_device: true })])(<DevicesSection />))
    await act(async () => undefined)
    await openAddMenu()
    await click(document.querySelector('[data-testid="settings-add-server-ssh"]'))
    await settle()
    expect(document.activeElement).toBe(target())
    expect(document.activeElement).not.toBe(composer)
    harness.cleanup()
    composer.remove()
  })

  it('没挑(Esc 关菜单):焦点回到「添加一台机器」按钮上,❌ 背后的输入框', async () => {
    installApi()
    const composer = focusedComposerBehind()
    const harness = createReactHarness()
    await harness.render(withDevices([device('mine', 'MacBook', { is_current_device: true })])(<DevicesSection />))
    await act(async () => undefined)
    const trigger = document.querySelector<HTMLElement>('[data-testid="settings-add-server-button"]')!
    trigger.focus()
    await openAddMenu()
    await key(menuItems()[0], 'Escape')
    await settle()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    harness.cleanup()
    composer.remove()
  })

  it('远程隧道:命令到了,焦点落在「复制」上', async () => {
    installApi()
    const composer = focusedComposerBehind()
    const harness = createReactHarness()
    await harness.render(withDevices([device('mine', 'MacBook', { is_current_device: true })])(<DevicesSection />))
    await act(async () => undefined)
    await openAddMenu()
    await click(document.querySelector('[data-testid="settings-add-server-tunnel"]'))
    await settle()
    const copy = document.querySelector('[data-testid="add-server-install-command"] button')
    expect(copy?.textContent).toBe('复制')
    expect(document.activeElement).toBe(copy)
    harness.cleanup()
    composer.remove()
  })
})
