// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ServerLoginApproveHost } from '../../../apps/desktop/src/mobile/server-login/ServerLoginApproveHost'

const m = vi.hoisted(() => ({
  chatsRead: false,
  open: vi.fn(async () => true),
  subscribe: vi.fn(),
  stop: vi.fn(),
  toast: vi.fn(),
  t: (key: string) => key,
}))
vi.mock('../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ chatsRead: m.chatsRead }) }))
vi.mock('../../../apps/desktop/src/lib/guguLinks', () => ({ openLink: m.open }))
vi.mock('../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => true }))
vi.mock('../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: m.toast }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: m.t }) }))
vi.mock('../../../apps/desktop/src/platform', () => ({ platform: { subscribeOpenedLinks: m.subscribe } }))
vi.mock('../../../apps/desktop/src/mobile/server-login/ServerLoginApproveSheet', () => ({ ServerLoginApproveSheet: () => null }))

it('consumes the native launch URL only after the signed-in chat list is ready', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const href = 'gugu-beta://chat/00000000-0000-4000-8000-000000000001'
  m.subscribe.mockImplementation((listener: (url: string) => void) => { listener(href); return m.stop })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(ServerLoginApproveHost, { active: false })))
    await act(async () => root.render(createElement(ServerLoginApproveHost, { active: true })))
    expect(m.subscribe).not.toHaveBeenCalled()
    expect(m.open).not.toHaveBeenCalled()
    m.chatsRead = true
    await act(async () => root.render(createElement(ServerLoginApproveHost, { active: true })))
    expect(m.open).toHaveBeenCalledExactlyOnceWith(href)
    await act(async () => root.render(createElement(ServerLoginApproveHost, { active: true })))
    expect(m.subscribe).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
  expect(m.stop).toHaveBeenCalledOnce()
})
