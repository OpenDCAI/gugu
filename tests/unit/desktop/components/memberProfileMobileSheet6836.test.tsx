// @vitest-environment jsdom
// #6836 手机上成员资料卡是底部面板(共用 Sheet,同长按面板、请求详情、改备注):贴在锚点旁边的 284 宽弹层,
// 在整行宽的成员页上左右都放不下,整张落在屏外。安卓返回键先关卡片,不关下面的成员页。桌面仍贴着锚点。
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberProfileCardModel } from '../../../../apps/desktop/src/components/MemberProfileCard'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

const shell = vi.hoisted(() => ({ mobile: true }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => shell.mobile }))

const { MemberProfilePopover } = await import('../../../../apps/desktop/src/components/MemberProfilePopover')
const { RightPanel } = await import('../../../../apps/desktop/src/components/chat/RightPanel')
const { NATIVE_BACK_EVENT } = await import('../../../../apps/desktop/src/components/ui/sheetStack')

const member: MemberProfileCardModel = { id: 'u-a', displayName: 'Alice', avatar: null, email: null, type: 'human', role: 'member', membership: 'current', profileScope: 'group' }
const card = () => document.body.querySelector<HTMLElement>('[data-testid="group-member-profile-menu"]')
const nativeBack = (): boolean => {
  const w = window as Window & { __guguNativeBackHandled?: boolean }
  w.__guguNativeBackHandled = false
  window.dispatchEvent(new CustomEvent(NATIVE_BACK_EVENT))
  return Boolean(w.__guguNativeBackHandled)
}

let harness: ReturnType<typeof createReactHarness>
let anchor: HTMLButtonElement
beforeEach(() => {
  harness = createReactHarness()
  anchor = document.body.appendChild(document.createElement('button'))
})
afterEach(() => {
  harness.cleanup()
  anchor.remove()
})

// 成员页先开着,再从它上面点开资料卡 —— 与手机上的先后一致。
async function openOnMemberPage(onClosePage: () => void, onCloseCard: () => void) {
  const page = (child: ReturnType<typeof createNode> | null) => createElement(RightPanel, { testId: 'member-page', onClose: onClosePage, children: child })
  await renderWithAppProviders(harness, page(null), { chat: {}, contacts: {} })
  await renderWithAppProviders(harness, page(createNode(MemberProfilePopover, { profile: { member, anchor, preferredSide: 'left', openedFrom: 'aside' }, onClose: onCloseCard })), { chat: {}, contacts: {} })
}

describe('#6836 member profile card on the phone', () => {
  it('opens as the bottom sheet, filling its width', async () => {
    shell.mobile = true
    await openOnMemberPage(vi.fn(), vi.fn())
    expect(card()?.getAttribute('data-sheet-mobile')).toBe('true')
    expect(document.body.querySelector('[data-slot="popover-positioner"]')).toBeNull()
    expect(card()?.querySelector('[data-profile-member-id="u-a"]')).not.toBeNull()
    expect(card()?.querySelector('.gg-pop')?.className).not.toContain('w-[284px]')
  })

  it('Android back closes the card, not the member page under it', async () => {
    shell.mobile = true
    const onClosePage = vi.fn()
    const onCloseCard = vi.fn()
    await openOnMemberPage(onClosePage, onCloseCard)
    expect(nativeBack()).toBe(true)
    expect(onCloseCard).toHaveBeenCalledOnce()
    expect(onClosePage).not.toHaveBeenCalled()
  })

  it('desktop: still the popover beside the element that opened it', async () => {
    shell.mobile = false
    await openOnMemberPage(vi.fn(), vi.fn())
    expect(document.body.querySelector('[data-slot="popover-positioner"]')).not.toBeNull()
    expect(card()?.getAttribute('data-sheet-mobile')).toBeNull()
    expect(card()?.querySelector('.gg-pop')?.className).toContain('w-[284px]')
  })
})
