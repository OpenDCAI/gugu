import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { ChatBottomDock } from '@/components/chat/ChatBottomDock'
import { AgentConversationView } from '@renderer/lib/chat/agent-conversation-view'
import { loadChatUi } from '@renderer/lib/chat/chat-transcript'
import { LocalizationProvider } from '@/i18n'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/session/renderer/features/assistant/assistant-today.css'
import '@/mobile/phone-look.css'

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
  root?.unmount()
  host?.remove()
  root = null
  host = null
})

// owner 10-28 手机试用:多打几行,输入框被 9999px 圆角压成了一个圆。
it('a multi-line phone composer grows into a rounded rectangle, not a circle', async () => {
  await page.viewport(390, 844)
  host = document.body.appendChild(document.createElement('div'))
  host.setAttribute('data-phone-shell', '')
  host.style.cssText = 'width:370px'
  root = createRoot(host)
  root.render(
    <LocalizationProvider>
      <ChatMessageComposer onSend={vi.fn(async () => {})} isGroupChat />
    </LocalizationProvider>,
  )
  await until('the phone composer has mounted', () => !!host?.querySelector('[data-slot="composer"][data-mobile] [contenteditable]'))
  const box = host.querySelector<HTMLElement>('[data-slot="composer-input"]')!
  const radius = () => Number.parseFloat(getComputedStyle(box).borderTopLeftRadius)
  const oneLine = box.getBoundingClientRect().height
  expect(radius(), 'one line is still a capsule').toBeGreaterThanOrEqual(oneLine / 2 - 1)

  await page.getByTestId('chat-composer').fill('一\n二\n三\n四\n五')
  await until('five lines grow the composer', () => box.getBoundingClientRect().height > oneLine * 2)
  const { height, width } = box.getBoundingClientRect()
  expect(radius()).toBeLessThan(height / 4)
  expect(width, 'the box keeps its width while it grows').toBeGreaterThan(height)
})

function rgbOf(css: string): number[] {
  const srgb = css.match(/color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)/)
  if (srgb) return [Number(srgb[1]), Number(srgb[2]), Number(srgb[3])]
  const m = css.match(/rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)/)
  if (!m) throw new Error(`unparsed color: ${css}`)
  return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255]
}
function contrast(a: number[], b: number[]): number {
  const lum = (c: number[]) => {
    const [r, g, bl] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** 计算后的颜色的不透明度:rgb() = 1;rgba(..., a) / color(srgb ... / a) = a。 */
function alphaOf(css: string): number {
  const slash = css.match(/\/\s*([\d.]+)\s*\)$/)
  if (slash) return Number(slash[1])
  const rgba = css.match(/^rgba\([^)]*,\s*([\d.]+)\)$/)
  return rgba ? Number(rgba[1]) : 1
}

// owner 10-28 手机试用:输入框完全透明,后面滚过的消息和输入的字叠在一起。
it.each(['dark', 'light'] as const)('%s: the phone composer row has a solid backing over the messages behind it', async (theme) => {
  await page.viewport(390, 844)
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light')
  host = document.body.appendChild(document.createElement('div'))
  host.setAttribute('data-phone-shell', '')
  host.setAttribute('data-ta-scope', '')
  host.style.cssText = 'position:relative;width:390px;height:600px;overflow:hidden;background:var(--ta-app-bg);color:var(--text-primary)'
  root = createRoot(host)
  root.render(
    <LocalizationProvider>
      <div data-test-messages="" style={{ fontSize: 40, lineHeight: '48px' }}>{Array.from({ length: 14 }, (_, index) => <p key={index}>消息 message {index}</p>)}</div>
      <ChatBottomDock reserve={false}>
        <div data-chat-composer="" style={{ padding: '8px 8px max(8px, env(safe-area-inset-bottom))' }}>
          <ChatMessageComposer onSend={vi.fn(async () => {})} isGroupChat />
        </div>
      </ChatBottomDock>
    </LocalizationProvider>,
  )
  await until('the phone composer has mounted', () => !!host?.querySelector('[data-slot="composer"][data-mobile] [contenteditable]'))
  const dock = host.querySelector<HTMLElement>('[data-chat-bottom-dock]')!
  const input = host.querySelector<HTMLElement>('[data-slot="composer-input"]')!
  expect(alphaOf(getComputedStyle(input).backgroundColor), 'the input itself is opaque').toBe(1)
  const band = getComputedStyle(dock.lastElementChild!, '::before')
  expect(alphaOf(band.backgroundColor), 'the composer row is backed').toBeGreaterThanOrEqual(0.85)
  const bandBox = dock.lastElementChild!.getBoundingClientRect()
  expect(bandBox.height).toBeGreaterThan(input.getBoundingClientRect().height)
  expect(Number.parseFloat(getComputedStyle(host).getPropertyValue('--chat-dock-h')), 'the message list reserves the dock height').toBeGreaterThanOrEqual(dock.getBoundingClientRect().height - 1)
  await page.getByTestId('chat-composer').fill('Typed text stays readable')
  const editor = host.querySelector<HTMLElement>('[contenteditable]')!
  expect(contrast(rgbOf(getComputedStyle(editor).color), rgbOf(getComputedStyle(input).backgroundColor)), 'the typed text reads on the input').toBeGreaterThanOrEqual(4.5)
  // 让一条消息正好一半压在输入那一行的底下,截图里看得出遮挡。
  const list = host.querySelector<HTMLElement>('[data-test-messages]')!
  const bandTop = dock.lastElementChild!.getBoundingClientRect().top - host.getBoundingClientRect().top
  list.style.marginTop = `${((bandTop - 24) % 48 + 48) % 48}px`
  await page.screenshot({ path: `phone-composer-backing-${theme}.png` })
})


it.each(['dark', 'light'] as const)('%s: the shared agent composer keeps the phone backing without changing desktop', async (theme) => {
  await page.viewport(390, 844)
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light')
  const { createChatContext, createChatState } = await loadChatUi()
  const context = createChatContext()
  const state = createChatState(context)
  host = document.body.appendChild(document.createElement('div'))
  host.setAttribute('data-phone-shell', '')
  host.setAttribute('data-ta-scope', '')
  host.style.cssText = 'position:relative;width:390px;height:600px;overflow:hidden;background:var(--bg)'
  root = createRoot(host)
  try {
    root.render(
      <LocalizationProvider>
        <AgentConversationView context={context} state={state} composerPlacement="bottom"
          style={{ position: 'absolute', inset: 0 }}
          composerContent={<ChatMessageComposer onSend={vi.fn(async () => {})} isGroupChat />} />
      </LocalizationProvider>,
    )
    await until('the shared phone composer has mounted', () => !!host?.querySelector('[data-chat-composer-placement="bottom"] [contenteditable]'))
    const layer = host.querySelector<HTMLElement>('[data-chat-composer-placement="bottom"]')!
    const row = layer.lastElementChild!
    const band = getComputedStyle(row, '::before')
    expect(band.content, 'the shared slot receives the phone backing').toBe('""')
    expect(alphaOf(band.backgroundColor)).toBeGreaterThanOrEqual(0.85)
    expect(Number.parseFloat(band.width), 'the backing covers the whole phone width').toBe(390)
    expect(row.getBoundingClientRect().height).toBeGreaterThan(0)
    host.removeAttribute('data-phone-shell')
    expect(getComputedStyle(row, '::before').content, 'desktop keeps its transparent positioning layer').toBe('none')
  } finally {
    root.unmount()
    root = null
    state.dispose()
    context.dispose()
  }
})

it.each([320, 390])('keeps permission, model and attachment controls separate on a %ipx agent composer', async (width) => {
  await page.viewport(width, 844)
  host = document.body.appendChild(document.createElement('div'))
  host.setAttribute('data-phone-shell', '')
  host.style.cssText = `width:${width}px`
  root = createRoot(host)
  root.render(
    <LocalizationProvider>
      <div data-agent-conversation=""><ChatMessageComposer onSend={vi.fn(async () => {})} conversation={{
        permissionModeOptions: { full: { name: '完全访问' } }, selectedPermissionMode: 'full',
        modelOptions: { default: { name: 'Default' } }, selectedModel: 'default',
      }} /></div>
    </LocalizationProvider>,
  )
  await until('the agent options have mounted', () => !!host?.querySelector('[data-slot="composer-permission-mode"]'))
  const permission = host.querySelector<HTMLElement>('[data-slot="composer-permission-mode"]')!.closest('button')!
  const attach = [...host.querySelectorAll<HTMLButtonElement>('[data-slot="composer-actions-start"] > button')].find(button => button !== permission)!
  const input = host.querySelector<HTMLElement>('[data-slot="composer-input"]')!
  const model = host.querySelector<HTMLElement>('[data-testid="composer-model-trigger"]')!
  const controls = [permission, attach, input, model]
  for (const [index, control] of controls.entries()) {
    const box = control.getBoundingClientRect()
    expect(box.width).toBeGreaterThan(0)
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(width)
    for (const other of controls.slice(index + 1)) {
      const next = other.getBoundingClientRect()
      const overlap = Math.min(box.right, next.right) - Math.max(box.left, next.left) > 1
        && Math.min(box.bottom, next.bottom) - Math.max(box.top, next.top) > 1
      expect(overlap, 'each option and the attachment button keeps its own visible target').toBe(false)
    }
  }
})
