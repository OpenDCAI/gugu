/**
 * #6264 SSH 提问卡片(密码 / 口令 / 验证码 / 新主机指纹 / 安全密钥)—— 真 Chromium、真 CSS、真组件。
 *
 * 浮在远端终端上的那一种照 Zed 的 RemoteConnectionModal:第一行「哪台机器」,中间一条输入带,
 * 底行状态 + 按钮。判据对着 owner 的那句「这个窗蛮奇怪的」拆成可量的几条:
 *   ① 上下文在卡片里面(第一行),❌ 卡片外另挂一颗说明胶囊;
 *   ② 浮卡里的输入框是一条带,❌ 再套一圈边框(实测 computed border 为 0);添加机器里的仍是常规输入框;
 *   ③ 答完不会「像没点上」:立刻停在「正在连接」,输入与按钮不可再点;
 *   ④ Esc = 取消(卡片自带取消时),与 Zed / VS Code 的连接提问一致;
 *   ⑤ 换了一个问题(新 id)卡片从头来 —— 卸载页没给 key 也一样。
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'

import '@/i18n/registerSettingsCatalog'
import { SshPromptCard, type SshPromptVariant } from '@/components/settings/addServer/SshPromptCard'
import { RemoteFloatingCard } from '@renderer/features/remote-hosts/remote-floating-card'
import type { SshPrompt } from '@shared/ssh-prompt'
import '@renderer/index.css'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  host = document.createElement('div')
  host.className = 'gugu-skin emlight'
  host.style.cssText = 'position:relative;width:640px;height:420px'
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  root.unmount()
  host.remove()
})

const password: SshPrompt = { id: 'p1', kind: 'password', message: "alice@box's password:", subject: 'alice@box' }
const context = { name: 'Linux 1', detail: 'alice@box:2222' }

function mount(prompt: SshPrompt, onAnswer: (value: string | null) => void, opts: { variant?: SshPromptVariant; pending?: boolean } = {}): void {
  const variant = opts.variant ?? 'floating'
  const card = (
    <SshPromptCard prompt={prompt} onAnswer={onAnswer} variant={variant} context={variant === 'floating' ? context : null} cancellable pending={opts.pending} />
  )
  root.render(variant === 'floating' ? <RemoteFloatingCard testId="floating">{card}</RemoteFloatingCard> : card)
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)

// root.render 的提交是异步的:每次挂载后等这一张卡片自己的那一块出现在 DOM 里。
// 用户操作(键入回车、点按钮)之后不必等:事件处理与它引起的提交都在这次派发里做完,userEvent 返回时已落地。
const floatingMounted = () => until('floating card mounted', () => q('ssh-prompt-context') != null)

it('① 浮卡:机器与地址写在卡片第一行,卡片外没有第二个浮起来的东西', async () => {
  mount(password, () => {})
  await floatingMounted()
  const header = q('ssh-prompt-context')!
  expect(header.textContent).toContain('Linux 1')
  expect(header.textContent).toContain('alice@box:2222')
  // 浮层只有一层:定位层下面直接是那张卡片,没有并排的说明胶囊。
  expect(q('floating')!.children).toHaveLength(1)
})

it('② 浮卡的输入框是一条带(无边框);添加机器里的是常规输入框', async () => {
  mount(password, () => {})
  await floatingMounted()
  expect(getComputedStyle(q('add-server-secret')!).borderTopWidth).toBe('0px')
  mount({ ...password, id: 'p2' }, () => {}, { variant: 'inline' })
  await until('inline card replaced the floating one', () => q('floating') == null && q('add-server-secret') != null)
  expect(getComputedStyle(q('add-server-secret')!).borderTopWidth).toBe('1px')
  expect(q('ssh-prompt-context')).toBeNull()
})

it('③ 回车提交后立刻停在「正在连接」:输入与按钮都不可再点', async () => {
  const onAnswer = vi.fn()
  mount(password, onAnswer)
  await floatingMounted()
  await userEvent.type(q('add-server-secret')!, 'hunter2{Enter}')
  expect(onAnswer).toHaveBeenCalledTimes(1)
  expect(onAnswer).toHaveBeenCalledWith('hunter2')
  expect(q('ssh-prompt-pending')).not.toBeNull()
  expect((q('add-server-secret') as HTMLInputElement).disabled).toBe(true)
  expect(q('ssh-prompt-cancel')).toBeNull()
  expect(host.querySelector('button[type="submit"]')).toBeNull()
})

it('③ 调用处说「已答完、在连」(pending)时同样停在「正在连接」', async () => {
  mount(password, () => {}, { pending: true })
  await floatingMounted()
  expect(q('ssh-prompt-pending')).not.toBeNull()
  expect((q('add-server-secret') as HTMLInputElement).disabled).toBe(true)
})

it('④ Esc = 取消', async () => {
  const onAnswer = vi.fn()
  mount(password, onAnswer)
  await floatingMounted()
  q('add-server-secret')!.focus()
  await userEvent.keyboard('{Escape}')
  expect(onAnswer).toHaveBeenCalledWith(null)
})

it('⑤ 密码不对再问一次(新 id + retry):卡片从头来,说清上次不对', async () => {
  const onAnswer = vi.fn()
  mount(password, onAnswer)
  await floatingMounted()
  await userEvent.type(q('add-server-secret')!, 'wrong{Enter}')
  expect(q('ssh-prompt-pending')).not.toBeNull()
  mount({ ...password, id: 'p9', retry: true }, onAnswer)
  await until('retry card replaced the answered one', () => q('ssh-prompt-retry') != null)
  expect(q('ssh-prompt-pending')).toBeNull()
  expect((q('add-server-secret') as HTMLInputElement).disabled).toBe(false)
  expect((q('add-server-secret') as HTMLInputElement).value).toBe('')
  expect(q('ssh-prompt-retry')).not.toBeNull()
})

it('新主机指纹:信任 = yes,之后停在「正在连接」', async () => {
  const onAnswer = vi.fn()
  mount({ id: 'h1', kind: 'hostKey', message: '', hostKey: { host: '[127.0.0.1]:2222', keyType: 'ED25519', fingerprint: 'SHA256:abc' } }, onAnswer)
  await until('host key card mounted', () => q('add-server-fingerprint') != null)
  expect(q('add-server-fingerprint')!.textContent).toBe('SHA256:abc')
  const trust = [...host.querySelectorAll('button')].at(-1)!
  await userEvent.click(trust)
  expect(onAnswer).toHaveBeenCalledWith('yes')
  expect(q('ssh-prompt-pending')).not.toBeNull()
})
