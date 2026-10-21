// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionOptionsPill } from '../../../apps/desktop/src/mobile/agent-watch/SessionOptionsPill'
import { CreateOptionsPill } from '../../../apps/desktop/src/mobile/agent-watch/CreateOptionsPill'
import { useOpenedOutputOpener } from '../../../apps/desktop/src/mobile/agent-watch/opened-output-opener'
import { ShareIntakeHost } from '../../../apps/desktop/src/mobile/share-intake/ShareIntakeHost'
import { ServerLoginApproveHost } from '../../../apps/desktop/src/mobile/server-login/ServerLoginApproveHost'
import { UI_EVENTS } from '../../../apps/desktop/src/lib/uiEvents'
import { SERVER_LOGIN_APPROVE_EVENT } from '../../../apps/desktop/src/lib/inAppLinks'
import type { IncomingShare } from '../../../apps/desktop/src/platform/types'
import { chat, clickElement, createNode, createReactHarness, renderWithAppProviders, waitForCondition } from '../../support/testHarness'
import { expectExit, frame, holdDialogExit } from '../../support/dialogExit'

const m = vi.hoisted(() => ({
  incoming: null as ((share: IncomingShare) => void) | null,
  options: { model: { selected: 'model-1', available: [{ id: 'model-1', name: 'Model' }] } },
  read: vi.fn(async () => new Uint8Array([1, 2, 3])),
  image: vi.fn(), revoke: vi.fn(), signal: null as AbortSignal | null,
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', async (original) => ({
  ...await original<typeof import('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc')>(), fetchSessionOptions: vi.fn(async () => m.options),
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/opened-output-open', async (original) => ({
  ...await original<typeof import('../../../apps/desktop/src/mobile/agent-watch/opened-output-open')>(),
  readWholeOpenedFile: (input: { signal: AbortSignal }) => { m.signal = input.signal; return m.read() },
}))
vi.mock('../../../apps/desktop/src/lib/imageViewer', () => ({ openImageViewer: m.image }))
vi.mock('../../../apps/desktop/src/platform', () => ({ platform: { kind: 'capacitor', subscribeIncomingShares: (fn: (share: IncomingShare) => void) => { m.incoming = fn; return () => { m.incoming = null } } } }))
vi.mock('../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => true }))
vi.mock('../../../apps/desktop/src/mobile/server-login/serverLoginApproval', () => ({ readServerLoginRequest: vi.fn(async () => ({ code: 'test-code', state: 'expired', machine: {} })) }))

let h: ReturnType<typeof createReactHarness>
let exit: ReturnType<typeof holdDialogExit>
beforeEach(() => {
  h = createReactHarness(); exit = holdDialogExit(); vi.clearAllMocks(); m.signal = null
  m.read.mockResolvedValue(new Uint8Array([1, 2, 3]))
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:preview' })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: m.revoke })
})
afterEach(() => { h.cleanup(); delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations })
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
async function back() { await act(async () => { window.dispatchEvent(new CustomEvent('gugu:native-back')) }) }

it('task options: clearing its current view retains choices through the full exit', async () => {
  await h.render(createNode(SessionOptionsPill, { deviceId: 'device-1', sessionId: 'task-1', busy: false }))
  await waitForCondition(() => q('agent-watch-options-open') !== null, 'options loaded')
  await clickElement(q('agent-watch-options-open')); await frame()
  const popup = q('agent-watch-options')
  await back()
  expect(popup.textContent).toContain('Model')
  await expectExit(popup, exit)
})

it('create options: clearing the view keeps the selected project until exit completes', async () => {
  await h.render(createNode(CreateOptionsPill, {
    options: { projects: [{ id: 'p1', name: 'Repo', path: '/repo' }], harnesses: [], lastUsed: null },
    selection: { projectId: 'p1', harness: null, model: null, permissionMode: null, sessionView: null, effort: null }, onChange: vi.fn(), busy: false, models: null, modelsState: 'idle',
  }))
  await clickElement(q('agent-watch-create-options-open')); await frame()
  const popup = q('agent-watch-create-options')
  await back()
  expect(popup.textContent).toContain('Repo')
  await expectExit(popup, exit)
})

function Preview({ path = '/repo/movie.mp4' }: { path?: string }) {
  const { handlers, panel } = useOpenedOutputOpener({ deviceId: 'device-1', sessionId: 'task-1' })
  return createNode('div', {}, createNode('button', { onClick: () => handlers.onOpenOutput?.({ output: { kind: 'file', path }, itemId: 'output-1' }) }, 'open'), panel)
}
it('file preview: aborts reading immediately and releases its blob only after closing', async () => {
  await h.render(createNode(Preview)); await clickElement(h.container.querySelector('button')!); await frame()
  const popup = q('opened-output-preview-sheet')
  await back()
  expect(m.revoke).not.toHaveBeenCalled()
  await expectExit(popup, exit)
  expect(m.revoke).toHaveBeenCalledExactlyOnceWith('blob:preview')
})
it('file preview: dismissing cancels a pending read before the exit completes', async () => {
  m.read.mockReturnValue(new Promise<Uint8Array<ArrayBuffer>>(() => {}))
  await h.render(createNode(Preview)); await clickElement(h.container.querySelector('button')!); await frame()
  const popup = q('opened-output-preview-sheet')
  await back()
  expect(m.signal?.aborted).toBe(true)
  await expectExit(popup, exit)
})
it('file preview: parent unmount cancels a pending read without a late completion', async () => {
  m.read.mockReturnValue(new Promise<Uint8Array<ArrayBuffer>>(() => {}))
  await h.render(createNode(Preview)); await clickElement(h.container.querySelector('button')!); await frame()
  await h.render(null)
  expect(m.signal?.aborted).toBe(true)
  await exit.finish()
  expect(m.image).not.toHaveBeenCalled()
})
it('image handoff: starts after the loading sheet exits and keeps the transferred blob valid', async () => {
  await h.render(createNode(Preview, { path: '/repo/image.png' })); await clickElement(h.container.querySelector('button')!)
  await frame()
  expect(m.image).not.toHaveBeenCalled()
  await expectExit(q('opened-output-preview-sheet'), exit)
  expect(m.image).toHaveBeenCalledWith([{ url: 'blob:preview', alt: 'image.png' }])
  expect(m.revoke).not.toHaveBeenCalled()
  await h.render(null)
  expect(m.revoke).toHaveBeenCalledExactlyOnceWith('blob:preview')
})

it('incoming-share host: dismissing nulls data while the last request remains visible until exit', async () => {
  await renderWithAppProviders(h, createNode(ShareIntakeHost, { active: true }), { chat: { chats: [] } })
  await act(async () => { m.incoming?.({ text: 'Shared request', files: [], failures: [] }) }); await frame()
  const popup = q('share-intake-sheet')
  await back()
  expect(popup.textContent).toContain('Shared request')
  await expectExit(popup, exit)
})
it('machine-approval host: clearing its code retains the request until exit', async () => {
  await renderWithAppProviders(h, createNode(ServerLoginApproveHost, { active: true }), { toast: vi.fn() })
  await act(async () => { window.dispatchEvent(new CustomEvent(SERVER_LOGIN_APPROVE_EVENT, { detail: { code: 'test-code' }, cancelable: true })) }); await frame()
  const popup = q('server-login-approve')
  await back()
  await expectExit(popup, exit)
})

it('incoming-share target selection: drafts immediately, navigates only after sheet exit', async () => {
  const navigate = vi.fn()
  window.addEventListener(UI_EVENTS.notificationClicked, navigate)
  try {
    await renderWithAppProviders(h, createNode(ShareIntakeHost, { active: true }), { chat: { chats: [chat({ id: 'group-1', kind: 'group', name: 'Group' })] } })
    await act(async () => { m.incoming?.({ text: 'Shared request', files: [], failures: [] }) }); await frame()
    const popup = q('share-intake-sheet')
    await clickElement(popup.querySelector('[data-share-target="group-1"]')!)
    expect(navigate).not.toHaveBeenCalled()
    await expectExit(popup, exit)
    expect(navigate).toHaveBeenCalledOnce()
  } finally { window.removeEventListener(UI_EVENTS.notificationClicked, navigate) }
})
