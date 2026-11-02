import type { ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { ChatComposer, type PromptEditorRef } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { ComposerTray, useComposerTrayBand } from '@renderer/features/sessions/composer-tray'
import { LOCAL_LIBRARY_HOST } from '@renderer/features/library/library-host'
import { sessionComposerBox, sessionComposerCardClassName, sessionComposerEmptyHeightPx, sessionComposerTrayClassName } from '@renderer/features/sessions/session-composer-styles'
// 主题层与同目录 composer-narrow-pane-7052 同一套。
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@/components/needsYou/NeedsYouSlot', () => ({ NeedsYouSlot: () => null }))

function TrayComposer(props: ComponentProps<typeof ChatComposer>) {
  return <ChatComposer {...props} bandAbove={useComposerTrayBand()} />
}

/**
 * gugu-dev#181 核对 21:会话页、新建会话页的输入框和格子里的群框是同一个框 —— 一样高,文字、底排在同一个位置。
 * 群框读的是 `sessionComposerBox` / `sessionComposerEmptyHeightPx`,这里量真的会话输入框,两边谁改了谁就红 —— ❌ 两处各写一个数。
 */
let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(async () => {
  await page.viewport(1200, 700)
  document.body.style.margin = '0'
  container = document.createElement('div')
  container.className = 'gugu-skin'
  container.style.width = '768px'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root?.unmount()
  container?.remove()
  root = null
  container = null
})

describe('the session composer\'s box', () => {
  it('joins the context tray to the card using the existing permission-band outline', async () => {
    root!.render(
      <SessionLocalizationProvider>
        <div data-testid="tray-composer">
          <ComposerTray projectPicker={<span>Project</span>} devicePicker={<span>Device</span>} host={LOCAL_LIBRARY_HOST}>
            <TrayComposer onSubmit={() => {}} />
          </ComposerTray>
        </div>
        <ChatComposer permissionRequest={{ requestId: 'band-geometry', title: 'Read', options: [] }} onResolvePermission={() => {}} onSubmit={() => {}} />
      </SessionLocalizationProvider>
    )
    const fixture = () => container!.querySelector<HTMLElement>('[data-testid="tray-composer"]')!
    const tray = () => fixture().getElementsByClassName(sessionComposerTrayClassName)[0] as HTMLElement
    const card = () => fixture().querySelector<HTMLElement>('[data-slot="composer-bar"]')!
    const band = () => container!.querySelector<HTMLElement>('[data-slot="composer-permission-request"]')!
    await until('tray and permission band have layout', () => !!fixture() && !!card() && !!band() && card().getBoundingClientRect().height > 0)
    const trayRect = tray().getBoundingClientRect()
    const cardRect = card().getBoundingClientRect()
    expect(trayRect.left).toBe(cardRect.left)
    expect(trayRect.right).toBe(cardRect.right)
    expect(trayRect.bottom).toBe(cardRect.top)
    const trayStyle = getComputedStyle(tray())
    const bandStyle = getComputedStyle(band())
    for (const property of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderBottomWidth'] as const) {
      expect(trayStyle[property], property).toBe(bandStyle[property])
    }
    expect(trayStyle.paddingTop).toBe(trayStyle.paddingBottom)
    expect(trayStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(getComputedStyle(card()).borderTopLeftRadius).toBe('0px')
    expect(getComputedStyle(card()).borderTopRightRadius).toBe('0px')
  })

  it.each(['permission', 'notice', 'queue'] as const)('keeps the tray flush with the card stack when %s is present', async (kind) => {
    root!.render(
      <SessionLocalizationProvider>
        <div data-testid="tray-composer">
          <ComposerTray projectPicker={<span>Project</span>} devicePicker={<span>Device</span>} host={LOCAL_LIBRARY_HOST}>
            <TrayComposer
              permissionRequest={kind === 'permission' ? { requestId: 'stack-geometry', title: 'Read', options: [] } : undefined}
              onResolvePermission={() => {}}
              notice={kind === 'notice' ? { variant: 'info', message: 'Notice' } : undefined}
              queuedPrompts={kind === 'queue' ? [{ id: 'queued', text: 'Queued message', origin: 'manual' }] : []}
              onEditQueuedPrompt={() => {}}
              onDeleteQueuedPrompt={() => {}}
              onReorderQueuedPrompts={() => {}}
              onSendQueuedPromptNow={() => {}}
              onSubmit={() => {}}
            />
          </ComposerTray>
        </div>
      </SessionLocalizationProvider>
    )
    const fixture = () => container!.querySelector<HTMLElement>('[data-testid="tray-composer"]')
    const tray = () => fixture()!.getElementsByClassName(sessionComposerTrayClassName)[0] as HTMLElement
    const card = () => fixture()!.querySelector<HTMLElement>('[data-slot="composer-bar"]')!
    const next = () => kind === 'queue' ? card() : fixture()!.querySelector<HTMLElement>(`[data-slot="composer-${kind === 'permission' ? 'permission-request' : 'notice'}"]`)!
    await until('stack has layout', () => !!fixture() && !!next() && next().getBoundingClientRect().height > 0 && next().parentElement!.getAnimations().length === 0)
    expect(tray().getBoundingClientRect().bottom).toBe(next().getBoundingClientRect().top)
    expect(getComputedStyle(tray()).borderTopLeftRadius).toBe(getComputedStyle(container!.querySelector<HTMLElement>('[data-slot="composer"]')!).getPropertyValue('--radius-thread').trim())
    for (const element of [next(), card()]) {
      expect(getComputedStyle(element).borderTopLeftRadius).toBe('0px')
      expect(getComputedStyle(element).borderTopRightRadius).toBe('0px')
    }
    if (kind === 'queue') {
      const queued = fixture()!.querySelector<HTMLElement>('[data-slot="composer-queued-prompts"]')!
      expect(queued.getBoundingClientRect().bottom).toBeLessThanOrEqual(tray().getBoundingClientRect().top)
    } else {
      expect(getComputedStyle(next()).borderTopWidth).toBe('0px')
      expect(next().getBoundingClientRect().bottom).toBe(card().getBoundingClientRect().top)
    }
  })

  it.each(['tray', 'permission', 'notice'] as const)('keeps the task outline around the whole %s stack', async (kind) => {
    root!.render(
      <SessionLocalizationProvider>
        <ComposerTray projectPicker={<span>Project</span>} devicePicker={<span>Device</span>} host={LOCAL_LIBRARY_HOST}>
          <TrayComposer
            tone="task"
            permissionRequest={kind === 'permission' ? { requestId: 'task-outline', title: 'Read', options: [] } : undefined}
            onResolvePermission={() => {}}
            notice={kind === 'notice' ? { variant: 'warning', message: 'Notice' } : undefined}
            onSubmit={() => {}}
          />
        </ComposerTray>
      </SessionLocalizationProvider>
    )
    const tray = () => container!.getElementsByClassName(sessionComposerTrayClassName)[0] as HTMLElement
    const card = () => container!.querySelector<HTMLElement>('[data-slot="composer-bar"]')!
    await until('task outline has layout', () => !!tray() && !!card() && card().getBoundingClientRect().height > 0)
    expect(getComputedStyle(tray()).borderRightColor).toBe(getComputedStyle(card()).borderRightColor)
    expect(getComputedStyle(card()).boxShadow).toBe('none')
    const stack = container!.querySelector<HTMLElement>('[data-composer-stack]')!
    expect(stack).not.toBeNull()
    expect(stack.getBoundingClientRect().top).toBe(tray().getBoundingClientRect().top)
    expect(stack.getBoundingClientRect().bottom).toBe(card().getBoundingClientRect().bottom)
    expect(stack.getBoundingClientRect().left).toBe(card().getBoundingClientRect().left)
    expect(stack.getBoundingClientRect().right).toBe(card().getBoundingClientRect().right)
    expect(getComputedStyle(stack).boxShadow).not.toBe('none')
    if (kind !== 'tray') {
      const band = container!.querySelector<HTMLElement>(`[data-slot="composer-${kind === 'permission' ? 'permission-request' : 'notice'}"]`)!
      expect(getComputedStyle(band).borderRightColor).toBe(getComputedStyle(card()).borderRightColor)
    }
  })

  it.each([false, true])('grows from its desktop or mobile minimum to the existing cap (mobile=%s)', async (mobile) => {
    const minimum = mobile ? 46 : sessionComposerBox.editorMinHeightPx
    const editorApiRef: { current: PromptEditorRef | null } = { current: null }
    root!.render(<SessionLocalizationProvider><ChatComposer mobile={mobile} editorApiRef={editorApiRef} onSubmit={() => {}} /></SessionLocalizationProvider>)
    const area = () => container!.querySelector<HTMLElement>('[data-slot="composer-input"]')!
    await until('editor at its minimum', () => !!editorApiRef.current && area()?.clientHeight === minimum)
    editorApiRef.current!.setText('One\nTwo\nThree\nFour')
    await until('four lines grow the input', () => area().clientHeight > minimum)
    expect(area().clientHeight).toBeLessThan(sessionComposerBox.editorMaxHeightPx)
    expect(area().scrollHeight).toBe(area().clientHeight)
    editorApiRef.current!.setText(Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join('\n'))
    await until('long text reaches the cap', () => area().clientHeight === sessionComposerBox.editorMaxHeightPx)
    expect(area().scrollHeight).toBeGreaterThan(area().clientHeight)
    expect(getComputedStyle(area()).overflowY).toBe('auto')
    editorApiRef.current!.clear()
    await until('clearing shrinks to its minimum', () => area().clientHeight === minimum)
  })

  it('is the box the group box in a block draws: its height, where the words start, where the bottom row sits', async () => {
    root!.render(
      <SessionLocalizationProvider>
        <ChatComposer
          permissionModeOptions={{ full: { name: '完全访问', destructive: true } }}
          selectedPermissionMode="full"
          onSubmit={() => {}}
          onStop={() => {}}
          onAttach={() => {}}
        />
      </SessionLocalizationProvider>
    )
    const card = () => document.querySelector<HTMLElement>('[data-slot="composer-bar"]')
    await until('输入框画出来', () => (card()?.getBoundingClientRect().height ?? 0) > 0)
    const box = card()!.getBoundingClientRect()
    const border = 1
    expect(Math.round(box.height)).toBe(sessionComposerEmptyHeightPx)

    const words = document.querySelector<HTMLElement>('[data-slot="composer-bar"] .ProseMirror')!.getBoundingClientRect()
    expect(Math.round(words.left - box.left - border)).toBe(sessionComposerBox.textInsetPx)
    expect(Math.round(box.right - border - words.right)).toBe(sessionComposerBox.textInsetPx)
    expect(Math.round(words.top - box.top - border)).toBe(sessionComposerBox.textTopPx)

    const controls = [...document.querySelectorAll<HTMLElement>('[data-slot="composer-toolbar"] button')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0)
      .sort((a, b) => a.left - b.left)
    const [first, second] = controls
    expect(Math.round(first.left - box.left - border)).toBe(sessionComposerBox.toolbarInsetPx)
    expect(Math.round(box.bottom - border - first.bottom)).toBe(sessionComposerBox.toolbarInsetPx)
    expect(Math.round(first.height)).toBe(sessionComposerBox.toolbarControlPx)
    expect(Math.round(second.left - first.right)).toBe(sessionComposerBox.toolbarGapPx)

    // 卡面:群框在格子里挂的那组类,画出来和真的会话框一样 —— 同一圈描边、同一个底、没有投影。
    // 两只框都静止着比:鼠标停在框外(上一个用例可能把它留在这里,`unhover` 停在 body 正中、可能正落在框上)、没有焦点、
    // 描边的过渡走完 —— 不然读到的是过渡中间的颜色。
    const probe = document.createElement('div')
    probe.className = sessionComposerCardClassName
    container!.appendChild(probe)
    const rest = document.createElement('div')
    rest.style.height = '24px'
    container!.appendChild(rest)
    await userEvent.hover(rest)
    ;(document.activeElement as HTMLElement | null)?.blur()
    const still = (el: HTMLElement) => !el.matches(':hover') && !el.matches(':focus-within') && el.getAnimations().length === 0
    await until('两只框都静止', () => still(card()!) && still(probe))
    const real = getComputedStyle(card()!)
    const drawn = getComputedStyle(probe)
    expect(drawn.borderTopWidth).toBe(real.borderTopWidth)
    expect(drawn.borderTopColor).toBe(real.borderTopColor)
    expect(drawn.backgroundColor).toBe(real.backgroundColor)
    expect(real.boxShadow).toBe('none')
    expect(drawn.boxShadow).toBe('none')
  })
})
