// @vitest-environment jsdom
import { act } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildIntegrationListPayload } from '../../../apps/desktop/electron/session/main/core/integrations/integration-payload-builder'
import { i18n, setLocalePreference } from '../../../apps/desktop/src/i18n'
import '../../../apps/desktop/src/i18n/registerAssistantCatalog'
import { PhoneConnectorDetail, PhoneConnectorsPage } from '../../../apps/desktop/src/mobile/assistant/PhoneConnectors'
import { PhoneConnectorSetupPage } from '../../../apps/desktop/src/mobile/assistant/PhoneConnectorSetup'
import { failureKey, type SetupFailure } from '../../../apps/desktop/src/mobile/assistant/phoneConnectorFlow'
import type { PhoneIntegrations } from '../../../apps/desktop/src/mobile/assistant/usePhoneProfileData'
import { clickElement, createNode, createReactHarness, deferred, waitForCondition } from '../../support/testHarness'

// #7199 手机连接应用的详情页与连接页:真目录(二十家)+ 假的助理的家(rpc 记下调用),渲染出来点一遍。
// 判据落在行为上:点了什么就发了什么调用、连上后重读状态、没断成就留在确认卡上。

const ui = vi.hoisted(() => ({ platformKind: 'capacitor' as 'capacitor' | 'web', rpc: null as unknown, listeners: [] as Array<(data: unknown) => void> }))

vi.mock('../../../apps/desktop/src/platform', () => ({ platform: { get kind() { return ui.platformKind } } }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  machineRpc: () => ui.rpc,
  onMachineEvent: (_device: string, _event: unknown, listener: (data: unknown) => void) => {
    ui.listeners.push(listener)
    return () => {
      ui.listeners = ui.listeners.filter((candidate) => candidate !== listener)
    }
  },
}))
vi.mock('../../../apps/desktop/src/components/devices/AssistantDeviceConnectors', () => ({ OtherDeviceConnectors: () => null, ThisDeviceConnectors: () => null }))
vi.mock('../../../apps/desktop/src/mobile/phone-device/PhoneDeviceActionsPage', () => ({ PhoneDeviceActionsPage: () => null }))
// 授权的协议那一半由 phoneConnectorFlow7199 用真授权服务跑过;这里只看页面怎么接它。
vi.mock('../../../apps/desktop/src/session/shared/mcp-oauth-client', () => ({
  beginMcpAuthorization: vi.fn(async (input: { redirectUrl: string; state: string }) => ({
    authorizationUrl: `https://auth.example/authorize?state=${input.state}&redirect_uri=${encodeURIComponent(input.redirectUrl)}`,
    complete: async (code: string) => ({ serverUrl: 'https://mcp.example', tokens: { access_token: `token-for-${code}` } }),
  })),
}))

const catalog = buildIntegrationListPayload('zh-CN') as unknown as PhoneIntegrations['items']
const assistant = { id: 'agent-1', display_name: '小咕', avatar: null, created_at: null }

type FakeRpc = ReturnType<typeof makeRpc>
function makeRpc() {
  return {
    integrations: {
      connect: vi.fn(async (_id: string, _input: unknown, _edit?: string): Promise<unknown> => ({ success: true, displayName: 'me@qq.com' })),
      disconnect: vi.fn(async (_id: string, _accountId?: string): Promise<unknown> => ({ success: true })),
      accounts: vi.fn(async (_id: string): Promise<unknown[]> => []),
      cliLoginStart: vi.fn(async (_id: string): Promise<unknown> => ({ success: true, prompt: { kind: 'device-link', url: 'https://login.dingtalk.com/?user_code=AB-12', code: 'AB-12' } })),
      cliLoginWait: vi.fn(async (_id: string): Promise<unknown> => ({ status: 'connected' })),
      cancelAuthorization: vi.fn(async (_id: string): Promise<unknown> => undefined),
    },
    github: {
      auth: vi.fn(async (): Promise<unknown> => ({ success: true, account: { login: 'octocat' } })),
      authCancel: vi.fn(async (): Promise<unknown> => ({ success: true })),
      listAccounts: vi.fn(async (): Promise<unknown[]> => []),
      removeAccount: vi.fn(async (_id: string): Promise<unknown> => ({ success: true })),
    },
  }
}

function pageProps(id: string, options: { configured?: Record<string, boolean>; statuses?: PhoneIntegrations['statuses'] } = {}) {
  const retry = vi.fn()
  const go = vi.fn()
  const integrations = {
    data: { items: catalog, configured: options.configured ?? {}, statuses: options.statuses ?? null },
    loading: false,
    error: null,
    retry,
  }
  return {
    retry,
    go,
    props: { assistant, chatId: 'chat-1', ownerName: null, homeDeviceId: "cloud-1", readiness: 'ready', machine: { state: 'opening' }, askInChat: vi.fn(), sub: `connector:${id}`, go, open: vi.fn(), integrations, id } as Record<string, unknown>,
  }
}

const q = <T extends Element = HTMLElement>(testId: string): T | null => document.querySelector<T>(`[data-testid="${testId}"]`)
const qa = (testId: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)]

/** React 的受控输入:走原型上的 value setter 再派 input 事件。 */
async function enter(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = element instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

let harness: ReturnType<typeof createReactHarness>
let rpc: FakeRpc
let opened: string[]
beforeEach(() => {
  setLocalePreference('zh-CN')
  harness = createReactHarness()
  rpc = makeRpc()
  ui.rpc = rpc
  ui.platformKind = 'capacitor'
  ui.listeners = []
  opened = []
  vi.spyOn(window, 'open').mockImplementation((url) => {
    opened.push(String(url))
    return null
  })
})
afterEach(() => {
  // 目录里缺键时界面会把键名原样画出来:任何一页都不该出现。
  expect(document.body.textContent).not.toMatch(/connectors\.[A-Za-z]+/)
  harness.cleanup()
})

const render = (node: Parameters<typeof createNode>[0], props: Record<string, unknown>) => harness.render(createNode(I18nextProvider, { i18n }, createNode(node, props)))

describe('直接展开的连接列表', () => {
  it('未连接的应用直接去授权,查看这一行才去详情', async () => {
    const page = pageProps('qq-mail')
    await render(PhoneConnectorsPage, { ...page.props, embedded: true })
    expect(q('assistant-connectors')!.querySelector('h1')).toBeNull()
    expect(q('assistant-connector-qq-mail')!.textContent).toContain('未连接')
    await clickElement(q('assistant-connect-qq-mail')!)
    expect(page.go).toHaveBeenLastCalledWith('connector:qq-mail:connect')
    await clickElement(q('assistant-connector-qq-mail')!)
    expect(page.go).toHaveBeenLastCalledWith('connector:qq-mail')
  })

  it('有凭据但尚未检查、授权已过期、检查失败分别显示真实状态', async () => {
    const page = pageProps('qq-mail', { configured: { 'qq-mail': true } })
    await render(PhoneConnectorsPage, page.props)
    expect(q('assistant-connector-qq-mail')!.textContent).toContain('正在检查')
    expect(q('assistant-connector-qq-mail')!.textContent).not.toContain('已连接')
    const data = page.props.integrations as { data: PhoneIntegrations }
    data.data.statuses = { 'qq-mail': { connected: false, errorType: 'authorization_expired', capabilities: { requiresRepositoryUrl: false, supportsIssueContext: false } } }
    await render(PhoneConnectorsPage, page.props)
    expect(q('assistant-connector-qq-mail')!.textContent).toContain('需要重新授权')
    expect(q('assistant-connect-qq-mail')!.textContent).toContain('重新连接')
    data.data.statusError = new Error('service unreachable')
    await render(PhoneConnectorsPage, page.props)
    expect(q('assistant-connector-qq-mail')!.textContent).toContain('检查没通过')
  })
})

describe('详情页', () => {
  it('没连:主按钮「连接」去连接页(connector:<id>:connect),没有「断开」', async () => {
    const page = pageProps('qq-mail')
    await render(PhoneConnectorDetail, page.props)
    expect(q('assistant-connector-detail')).not.toBeNull()
    expect(q('assistant-connector-disconnect')).toBeNull()
    await clickElement(q('assistant-connector-connect')!)
    expect(page.go).toHaveBeenCalledWith('connector:qq-mail:connect')
  })

  it('已连的单账号:「断开连接」先弹确认,确认才发 disconnect(整家,不带 accountId),成功后重读状态', async () => {
    const page = pageProps('dida', { configured: { dida: true } })
    await render(PhoneConnectorDetail, page.props)
    await clickElement(q('assistant-connector-disconnect')!)
    expect(rpc.integrations.disconnect).not.toHaveBeenCalled()
    expect(q('assistant-connector-disconnect-dialog')).not.toBeNull()
    await clickElement(q('assistant-connector-disconnect-dialog-confirm')!)
    await waitForCondition(() => rpc.integrations.disconnect.mock.calls.length === 1, 'disconnect called')
    expect(rpc.integrations.disconnect).toHaveBeenCalledWith('dida', undefined)
    await waitForCondition(() => page.retry.mock.calls.length === 1, 'status re-read')
    await waitForCondition(() => q('assistant-connector-disconnect-dialog') === null, 'dialog closed')
  })

  it('取消确认:不发 disconnect', async () => {
    const page = pageProps('dida', { configured: { dida: true } })
    await render(PhoneConnectorDetail, page.props)
    await clickElement(q('assistant-connector-disconnect')!)
    const cancel = [...document.querySelectorAll<HTMLElement>('[data-testid="assistant-connector-disconnect-dialog"] button')].find((button) => !button.getAttribute('data-testid'))!
    await clickElement(cancel)
    expect(rpc.integrations.disconnect).not.toHaveBeenCalled()
    expect(q('assistant-connector-disconnect-dialog')).toBeNull()
  })

  it('没断成:确认卡留在原地说没断开,不重读、不当作断开了', async () => {
    rpc.integrations.disconnect.mockResolvedValue({ success: false, error: 'locked' })
    const page = pageProps('dida', { configured: { dida: true } })
    await render(PhoneConnectorDetail, page.props)
    await clickElement(q('assistant-connector-disconnect')!)
    await clickElement(q('assistant-connector-disconnect-dialog-confirm')!)
    await waitForCondition(() => document.querySelector('.ta-phone-confirm-failed') !== null, 'failure shown on the card')
    expect(q('assistant-connector-disconnect-dialog')).not.toBeNull()
    expect(page.retry).not.toHaveBeenCalled()
  })

  it('多账号(邮箱):逐个列账号,只断开点的那一个(带 accountId),没有整家断开', async () => {
    rpc.integrations.accounts.mockResolvedValue([
      { accountId: 'imap.qq.com:a@qq.com', displayName: 'a@qq.com', connectedAt: Date.UTC(2026, 9, 1, 12), isDefault: true, fields: { email: 'a@qq.com' } },
      { accountId: 'imap.qq.com:b@qq.com', connectedAt: Date.UTC(2026, 9, 2, 12), isDefault: false, fields: { email: 'b@qq.com' } },
    ])
    const page = pageProps('qq-mail', { configured: { 'qq-mail': true } })
    await render(PhoneConnectorDetail, page.props)
    await waitForCondition(() => qa('assistant-connector-account').length === 2, 'two accounts listed')
    expect(q('assistant-connector-disconnect')).toBeNull()
    expect(document.body.textContent).toContain('b@qq.com')
    await clickElement(qa('assistant-connector-account-disconnect')[1]!)
    await clickElement(q('assistant-connector-disconnect-dialog-confirm')!)
    await waitForCondition(() => rpc.integrations.disconnect.mock.calls.length === 1, 'disconnect called')
    expect(rpc.integrations.disconnect).toHaveBeenCalledWith('qq-mail', 'imap.qq.com:b@qq.com')
  })

  it('邮箱:账号清单读不到 / 还在读时,不给整家「断开连接」(它会一次断掉所有邮箱),给「重试」', async () => {
    rpc.integrations.accounts.mockRejectedValue(new Error('link closed'))
    const page = pageProps('qq-mail', { configured: { 'qq-mail': true } })
    await render(PhoneConnectorDetail, page.props)
    await waitForCondition(() => q('assistant-connector-accounts-retry') !== null, 'retry shown')
    expect(q('assistant-connector-disconnect')).toBeNull()
  })

  it('邮箱:那台机器比多账号老(unknown_method)= 按单账号画,有整家「断开连接」', async () => {
    rpc.integrations.accounts.mockRejectedValue(Object.assign(new Error('unknown method'), { code: 'unknown_method' }))
    const page = pageProps('qq-mail', { configured: { 'qq-mail': true } })
    await render(PhoneConnectorDetail, page.props)
    await waitForCondition(() => q('assistant-connector-disconnect') !== null, 'single-account disconnect shown')
    expect(qa('assistant-connector-account')).toHaveLength(0)
  })

  it('GitHub:账号走自己的移除口(github.removeAccount)', async () => {
    rpc.github.listAccounts.mockResolvedValue([{ accountId: 'gh-1', login: 'octocat', host: 'github.com', avatarUrl: '', credentialSource: 'device_flow', isDefault: true }])
    const page = pageProps('github', { configured: { github: true } })
    await render(PhoneConnectorDetail, page.props)
    await waitForCondition(() => qa('assistant-connector-account').length === 1, 'github account listed')
    await clickElement(q('assistant-connector-account-disconnect')!)
    await clickElement(q('assistant-connector-disconnect-dialog-confirm')!)
    await waitForCondition(() => rpc.github.removeAccount.mock.calls.length === 1, 'remove called')
    expect(rpc.github.removeAccount).toHaveBeenCalledWith('gh-1')
    expect(rpc.integrations.disconnect).not.toHaveBeenCalled()
  })

  it('网页版上浏览器授权的服务:如实说要 App,❌ 摆一个必败的连接钮', async () => {
    ui.platformKind = 'web'
    const page = pageProps('tencent-docs')
    await render(PhoneConnectorDetail, page.props)
    expect(q('assistant-connector-connect')).toBeNull()
    expect(q('assistant-connector-connect-note')).not.toBeNull()
  })
})

describe('连接页:表单', () => {
  it('必填没填提交钮灰着;填了提交 → connect(id, 去空白的输入),成功后重读状态并说已连接', async () => {
    const page = pageProps('qq-mail')
    await render(PhoneConnectorSetupPage, { ...page.props, sub: 'connector:qq-mail:connect' })
    expect(q('assistant-connector-form')).not.toBeNull()
    const submit = q<HTMLButtonElement>('assistant-connector-submit')!
    expect(submit.disabled).toBe(true)
    const fields = [...document.querySelectorAll<HTMLInputElement>('[data-testid^="assistant-connector-field-"]')]
    expect(fields.length).toBeGreaterThanOrEqual(2)
    for (const field of fields) await enter(field, ` ${field.getAttribute('data-testid')!.replace('assistant-connector-field-', '')}-value `)
    expect(submit.disabled).toBe(false)
    await clickElement(submit)
    await waitForCondition(() => rpc.integrations.connect.mock.calls.length === 1, 'connect called')
    const [id, input] = rpc.integrations.connect.mock.calls[0]!
    expect(id).toBe('qq-mail')
    for (const value of Object.values(input as Record<string, string>)) expect(value).not.toMatch(/^\s|\s$/)
    await waitForCondition(() => q('assistant-connector-done') !== null, 'done shown')
    expect(page.retry).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('me@qq.com')
    await clickElement(q('assistant-connector-done-finish')!)
    expect(page.go).toHaveBeenCalledWith('connector:qq-mail')
  })

  it('对方不认:留在表单上说哪一步没成(类型按界面语言说),可重试', async () => {
    rpc.integrations.connect.mockResolvedValue({ success: false, error: 'LOGIN failed', errorType: 'auth_failed' })
    const page = pageProps('qq-mail')
    await render(PhoneConnectorSetupPage, { ...page.props, sub: 'connector:qq-mail:connect' })
    for (const field of document.querySelectorAll<HTMLInputElement>('[data-testid^="assistant-connector-field-"]')) await enter(field, 'x')
    await clickElement(q('assistant-connector-submit')!)
    await waitForCondition(() => q('assistant-connector-failure') !== null, 'failure shown')
    expect(q('assistant-connector-failure')!.getAttribute('data-step')).toBe('save')
    expect(q('assistant-connector-done')).toBeNull()
    expect(page.retry).not.toHaveBeenCalled()
    expect(q('assistant-connector-retry')).not.toBeNull()
  })
})

describe('连接页:浏览器授权', () => {
  async function startAuthorization(id = 'tencent-docs') {
    const page = pageProps(id)
    await render(PhoneConnectorSetupPage, { ...page.props, sub: `connector:${id}:connect` })
    await clickElement(q('assistant-connector-authorize')!)
    await waitForCondition(() => q('assistant-connector-paste') !== null, 'waiting for the pasted address')
    return page
  }

  it('点「前往授权」:系统浏览器收到授权页地址;贴回回跳(带授权结果)就自动换令牌 + connect', async () => {
    const page = await startAuthorization()
    expect(opened).toHaveLength(1)
    const authorization = new URL(opened[0]!)
    const state = authorization.searchParams.get('state')!
    const redirect = authorization.searchParams.get('redirect_uri')!
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    await enter(q<HTMLTextAreaElement>('assistant-connector-paste')!, `${redirect}?code=abc&state=${state}`)
    await waitForCondition(() => rpc.integrations.connect.mock.calls.length === 1, 'connect called')
    expect(rpc.integrations.connect).toHaveBeenCalledWith('tencent-docs', { serverUrl: 'https://mcp.example', tokens: { access_token: 'token-for-abc' } })
    await waitForCondition(() => q('assistant-connector-done') !== null, 'done shown')
    expect(page.retry).toHaveBeenCalledTimes(1)
  })

  it('贴了不是回跳的:留着等并提示;重新打开授权页再开一次', async () => {
    await startAuthorization()
    await enter(q<HTMLTextAreaElement>('assistant-connector-paste')!, 'hello')
    await clickElement(q('assistant-connector-paste-submit')!)
    await waitForCondition(() => q('assistant-connector-paste-hint') !== null, 'hint shown')
    expect(rpc.integrations.connect).not.toHaveBeenCalled()
    await clickElement(q('assistant-connector-reopen')!)
    expect(opened).toHaveLength(2)
  })

  it('授权页被对方的 App 接走了:能复制授权链接,到浏览器里自己打开', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await startAuthorization()
    await clickElement(q('assistant-connector-copy-auth-link')!)
    expect(writeText).toHaveBeenCalledWith(opened[0])
  })

  it('人拒绝了授权:说是拒绝(带 data-reason),不 connect', async () => {
    await startAuthorization()
    const state = new URL(opened[0]!).searchParams.get('state')!
    await enter(q<HTMLTextAreaElement>('assistant-connector-paste')!, `http://127.0.0.1:50000/callback?error=access_denied&state=${state}`)
    await waitForCondition(() => q('assistant-connector-failure') !== null, 'failure shown')
    expect(q('assistant-connector-failure')!.getAttribute('data-reason')).toBe('denied')
    expect(rpc.integrations.connect).not.toHaveBeenCalled()
  })

  it('取消:回到起点,贴了也不会连', async () => {
    await startAuthorization()
    await clickElement(q('assistant-connector-cancel')!)
    await waitForCondition(() => q('assistant-connector-authorize') !== null, 'back to the start')
    expect(rpc.integrations.connect).not.toHaveBeenCalled()
  })
})

describe('连接页:官方命令行 / GitHub', () => {
  it('飞书:应用配置二维码切换为个人授权二维码，完成后刷新连接状态', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    rpc.integrations.cliLoginStart.mockResolvedValue({ success: true, prompt: { kind: 'qr-code', image: 'data:image/png;base64,CONFIG', url: 'https://open.feishu.cn/page/cli?user_code=CONFIG' } })
    rpc.integrations.cliLoginWait.mockReturnValueOnce(first.promise).mockReturnValue(second.promise)
    const page = pageProps('feishu')
    await render(PhoneConnectorSetupPage, { ...page.props, sub: 'connector:feishu:connect' })
    expect(q('assistant-connector-cli')).not.toBeNull()
    expect(q('assistant-connector-authorize')).toBeNull()
    await clickElement(q('assistant-connector-cli-start')!)
    await waitForCondition(() => q('assistant-connector-qr') !== null, 'configuration qr shown')
    expect(document.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,CONFIG')
    await act(async () => first.resolve({ status: 'pending', prompt: { kind: 'qr-code', image: 'data:image/png;base64,USER', url: 'https://accounts.feishu.cn/verify?user_code=USER' } }))
    await waitForCondition(() => document.querySelector('img')?.getAttribute('src') === 'data:image/png;base64,USER', 'personal authorization qr shown')
    await clickElement(q('assistant-connector-open-link')!)
    expect(opened).toEqual(['https://accounts.feishu.cn/verify?user_code=USER'])
    await act(async () => second.resolve({ status: 'connected' }))
    await waitForCondition(() => q('assistant-connector-done') !== null, 'done shown')
    expect(page.retry).toHaveBeenCalledTimes(1)
    expect(rpc.integrations.cliLoginStart).toHaveBeenCalledWith('feishu')
    expect(rpc.integrations.connect).not.toHaveBeenCalled()
  })

  it('钉钉:点「连接」→ 起登录 → 摆出授权码与「打开授权页」,确认后连上', async () => {
    const wait = deferred<unknown>()
    rpc.integrations.cliLoginWait.mockReturnValue(wait.promise)
    const page = pageProps('dingtalk')
    await render(PhoneConnectorSetupPage, { ...page.props, sub: 'connector:dingtalk:connect' })
    await clickElement(q('assistant-connector-cli-start')!)
    await waitForCondition(() => q('assistant-connector-code') !== null, 'device code shown')
    expect(q('assistant-connector-code')!.textContent).toBe('AB-12')
    expect(rpc.integrations.cliLoginStart).toHaveBeenCalledWith('dingtalk')
    await clickElement(q('assistant-connector-open-link')!)
    expect(opened).toEqual(['https://login.dingtalk.com/?user_code=AB-12'])
    await act(async () => wait.resolve({ status: 'connected' }))
    await waitForCondition(() => q('assistant-connector-done') !== null, 'done shown')
    expect(page.retry).toHaveBeenCalledTimes(1)
  })

  it('企业微信:二维码 + 可打开的链接;取消时撤掉那台机器上的登录', async () => {
    rpc.integrations.cliLoginStart.mockResolvedValue({ success: true, prompt: { kind: 'qr-code', image: 'data:image/png;base64,AAA', url: 'https://work.weixin.qq.com/x' } })
    rpc.integrations.cliLoginWait.mockReturnValue(new Promise(() => {}))
    const page = pageProps('wecom')
    await render(PhoneConnectorSetupPage, { ...page.props, sub: 'connector:wecom:connect' })
    await clickElement(q('assistant-connector-cli-start')!)
    await waitForCondition(() => q('assistant-connector-qr') !== null, 'qr shown')
    expect(document.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAA')
    await clickElement(q('assistant-connector-cancel')!)
    expect(rpc.integrations.cancelAuthorization).toHaveBeenCalledWith('wecom')
  })

  it('GitHub:先订设备码推送再发起 auth;码到了摆出来,复制并打开 GitHub 页,授权成功后已连接', async () => {
    const auth = deferred<unknown>()
    rpc.github.auth.mockReturnValue(auth.promise)
    const page = pageProps('github')
    await render(PhoneConnectorSetupPage, { ...page.props, sub: 'connector:github:connect' })
    await clickElement(q('assistant-connector-github-start')!)
    expect(ui.listeners).toHaveLength(1)
    expect(rpc.github.auth).toHaveBeenCalledTimes(1)
    await act(async () => ui.listeners[0]!({ userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }))
    expect(q('assistant-connector-code')!.textContent).toBe('WDJB-MJHT')
    await clickElement(q('assistant-connector-github-open')!)
    expect(opened).toEqual(['https://github.com/login/device'])
    await act(async () => auth.resolve({ success: true, account: { login: 'octocat' } }))
    await waitForCondition(() => q('assistant-connector-done') !== null, 'done shown')
    expect(document.body.textContent).toContain('@octocat')
    expect(ui.listeners).toHaveLength(0)
  })
})

describe('文案键齐全(中英各一份)', () => {
  const steps: SetupFailure['step'][] = ['prepare', 'authorize', 'exchange', 'save', 'install', 'login', 'github']
  const reasons: SetupFailure['reason'][] = ['denied', 'timeout', 'rejected', 'failed']
  const keys = [
    ...new Set(steps.flatMap((step) => reasons.map((reason) => failureKey({ step, reason })))),
    ...['empty', 'not-callback', 'state-mismatch'].map((hint) => `hint.${hint}`),
  ]

  it.each(['zh-CN', 'en-US'])('%s:每种失败 / 每条粘贴提示都有话说', (lng) => {
    for (const key of keys) {
      const full = `connectors.setup.${key}`
      expect(i18n.exists(full, { ns: 'assistant', lng }), `${lng} ${full}`).toBe(true)
    }
  })
})
