import { act, useLayoutEffect, useState } from 'react'
import { afterEach, expect, it, onTestFailed, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store'
import { state, changed, EMPTY } from '@/lib/sessionInputOutboxBridge'
import { chatStore, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { SessionInputQueue } from '@/components/chat/SessionInputQueue'
import type { SessionInputOutbox } from '@/lib/sessionInputOutbox'
import { PhoneViewportShell } from '@/mobile/PhoneViewportShell'
import '@/styles/tokens.css'
import '@renderer/index.css'
import { readComposer, writeComposer } from '../../../../../../../tests/support/composerEditor'
import { phoneDraftTrace } from '../../../../../../../tests/support/phoneDraftTrace'
import type { LifeView } from '@shared/core/sessions/session-life'

vi.mock('@/components/chat/useChatDraft', async original => {
  const actual = await original<typeof import('@/components/chat/useChatDraft')>()
  const { useCallback, useEffect, useLayoutEffect } = await import('react')
  const { phoneDraftTrace: trace } = await import('../../../../../../../tests/support/phoneDraftTrace')
  return { ...actual, useChatDraft: (...args: Parameters<typeof actual.useChatDraft>) => {
    const value = actual.useChatDraft(...args)
    trace.note('mirror.render', { text: value.text, setter: trace.id(value.setText), flush: trace.id(value.flush) })
    const setText = useCallback((update: Parameters<typeof value.setText>[0]) => {
      trace.note('onChange.enter', typeof update === 'string' ? update : 'functional', true)
      value.setText(update)
      trace.note('onChange.sync-mirror-return')
    }, [value.setText])
    useLayoutEffect(() => { trace.note('mirror.layout', value.text) }, [value.text])
    useEffect(() => {
      trace.note('flush-effect.setup', trace.id(value.flush))
      return () => { trace.note('flush-effect.cleanup', trace.id(value.flush), true) }
    }, [value.flush])
    return { ...value, setText }
  } }
})

const life = vi.hoisted(() => ({ view: null as LifeView | null }))
const release = vi.hoisted(() => vi.fn(async () => null))
vi.mock('@/lib/sessionInputOutboxBridge', async original => ({ ...(await original<object>()), releaseQueuedSessionInput: release }))

vi.mock('@gugu/core/cloud/config', async original => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: { chatView: 'double' } }) }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async original => ({
  ...(await original<object>()), fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  machineRpc: vi.fn(() => ({})), fetchBackgroundTasks: vi.fn(async () => []),
}))
vi.mock('@/mobile/agent-watch/useSessionLifeView', () => ({ useSessionLifeView: () => ({ view: life.view, error: null, current: () => life.view }) }))

let harness: ReturnType<typeof createReactHarness>
afterEach(() => {
  harness?.cleanup()
  phoneDraftTrace.end()
  const own = state()
  own.accountId = null; own.queue = null; own.rows = EMPTY; own.valid = () => false; changed()
  life.view = null; release.mockClear()
})

it('holds an opened queue until the authoritative life view arrives after history, including a late user stop', async () => {
  await page.viewport(390, 844)
  const timeline = emptyAgentWatchTimeline()
  timeline.turns = [{ id: 'completed-history', seq: 1, initiator: 'user', items: [], outcome: { kind: 'done' } }]
  Object.assign(state(), { accountId: 'owner', valid: () => true, rows: [
    { id: 'held', accountId: 'owner', deviceId: 'host', sessionId: 'session', text: 'stay held', createdAt: 1, queued: true, sendQueue: { order: 1 } },
  ] })
  harness = createReactHarness()
  harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column'
  const render = () => renderWithAppProviders(harness, <SessionConversation timeline={timeline} deviceId="host" sessionId="session" agentName="Agent" nativeRecord
    queueReady sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking={false}
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} />, { contacts: {} })
  await render()
  await until('held row is rendered while life is loading', () => !!harness.container.querySelector('[data-queued-prompt-id="held"]'))
  expect(release).not.toHaveBeenCalled()
  life.view = { sessionId: 'session', version: 1, kind: 'ready', stage: null, hold: 'user-stop', failure: null, lastExit: null, nativeSession: null,
    pending: { count: 0, items: [] } }
  await render()
  expect(release).not.toHaveBeenCalled()
  life.view = { ...life.view, hold: null }
  await render()
  await until('a confirmed ready foreground permits release', () => release.mock.calls.length === 1)
})

it('keeps a held input editable from its first frame, then keeps the sent input in the transcript', async () => {
  await page.viewport(390, 844)
  const timeline = emptyAgentWatchTimeline()
  const own = state()
  own.accountId = 'owner'; own.rows = EMPTY; own.valid = () => true
  let commit!: () => void
  const durable = new Promise<void>(resolve => { commit = resolve })
  const send = vi.fn(async (text: string) => {
    await durable
    own.rows = [{ id: 'local', accountId: 'owner', deviceId: 'host', sessionId: 'session', text, createdAt: 1, queued: true, sendQueue: { order: 1 } }]
    changed()
  })
  harness = createReactHarness()
  harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column'
  const render = () => renderWithAppProviders(harness, <SessionConversation timeline={timeline} deviceId="host" sessionId="session" agentName="Agent" nativeRecord
    sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={send} pendingSends={[]} sending={false} agentWorking
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} footerNotice={<SessionInputQueue sessionId="session" waitingForConnection />} />, { contacts: {} })
  await render()
  await page.getByTestId('prompt-editor').fill('local queue appears now')
  const stop = harness.container.querySelector('[data-composer-action="stop"]')
  expect(stop).toBeNull()
  await page.getByRole('button', { name: translateSessionMessage('composer.sendMessage'), exact: true }).click()
  await until('submission has started', () => send.mock.calls.length === 1)
  expect(harness.container.querySelector('[data-queued-prompt-id="local"]')).toBeNull()
  expect(page.getByTestId('prompt-editor').element().textContent).toBe('local queue appears now')
  await act(async () => { commit(); await durable })
  await until('durable local queue is visible before the host responds', () => !!harness.container.querySelector('[data-queued-prompt-id="local"]'))
  await until('the committed input is handed off from the editor', () => page.getByTestId('prompt-editor').element().textContent === '')
  expect(harness.container.querySelector('[data-queued-prompt-id="local"]')?.textContent).toContain('local queue appears now')
  expect(harness.container.querySelector('[data-native-input-id="local"]')).toBeNull()
  expect(harness.container.querySelector('[data-queued-prompt-id="local"] [data-locked="true"]')).toBeNull()
  expect(harness.container.querySelector('[data-user-card="local"]')).toBeNull()
  await page.screenshot({ path: '__screenshots__/1344-phone-held.png' })
  await act(async () => { own.rows = own.rows.map(input => ({ ...input, queued: false, sendQueue: undefined })); changed() })
  await until('explicit release puts the now-sent input in the transcript', () => !!harness.container.querySelector('[data-user-card="local"]') && !!harness.container.querySelector('[data-send-state="sending"]'))
  timeline.queuedPrompts = [{ id: 'runtime-local', clientMessageId: 'local', text: 'local queue appears now' }]
  await act(async () => { own.rows = EMPTY; changed() })
  await render()
  expect(harness.container.querySelector('[data-queued-prompt-id="local"]')).toBeNull()
  expect(harness.container.querySelector('[data-queued-prompt-id="runtime-local"]')).toBeNull()
  await until('host custody stays on the same sent input with receiving dots', () => !!harness.container.querySelector('[data-user-card="local"]') && !!harness.container.querySelector('[data-send-state="receiving"]'))
  timeline.queuedPrompts = []
  timeline.turns = [{ id: 'provider-turn', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', role: 'user', id: 'provider-local', seq: 0, text: 'local queue appears now', _meta: { guguClientMessageId: 'local' } },
  ] }]
  await render()
  expect(harness.container.querySelector('[data-queued-prompt-id]')).toBeNull()
})

it.each((['accepted', 'failed'] as const).flatMap(result => (['append', 'replace', 'shared-prefix', 'clear', 'unchanged'] as const).map(edit => ({ result, edit }))))('preserves words typed during durable custody ($result / $edit)', async ({ result, edit }) => {
  await page.viewport(390, 844)
  const timeline = emptyAgentWatchTimeline()
  const own = state()
  own.accountId = 'owner'; own.rows = EMPTY; own.valid = () => true
  const submitted = edit === 'shared-prefix' ? 'Hi' : 'queued original'
  const live = edit === 'append' ? `${submitted} appended words` : edit === 'shared-prefix' ? 'Hi again'
    : edit === 'clear' ? '' : edit === 'unchanged' ? submitted : 'new draft'
  let commit!: () => void
  const durable = new Promise<void>(resolve => { commit = resolve })
  const send = vi.fn(async (text: string) => {
    await durable
    if (result === 'failed') throw Error('storage unavailable')
    own.rows = [{ id: 'local', accountId: 'owner', deviceId: 'host', sessionId: 'session', text, createdAt: 1, queued: true, sendQueue: { order: 1 } }]
    changed()
  })
  harness = createReactHarness()
  harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column'
  await renderWithAppProviders(harness, <SessionConversation timeline={timeline} deviceId="host" sessionId="session" agentName="Agent" nativeRecord
    sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={send} pendingSends={[]} sending={false} agentWorking
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} />, { contacts: {} })
  await page.getByTestId('prompt-editor').fill(submitted)
  await page.getByRole('button', { name: translateSessionMessage('composer.sendMessage'), exact: true }).click()
  await until('durable custody has started', () => send.mock.calls.length === 1)
  expect(page.getByTestId('prompt-editor').element().textContent).toBe(submitted)
  await page.getByTestId('prompt-editor').fill(live)
  await act(async () => { commit(); await send.mock.results[0].value.catch(() => {}) })
  const expected = result === 'accepted' && live === submitted ? '' : live
  const current = page.getByTestId('prompt-editor').element().textContent!
  expect(current).toBe(expected)
  if (result === 'failed') expect(own.rows).toHaveLength(0)
  expect(send).toHaveBeenCalledTimes(1)
})

it('shows and retries an online host refusal outside the normal locked queue', async () => {
  await page.viewport(390, 844)
  const own = state()
  const flush = vi.fn(async () => {})
  own.accountId = 'owner'; own.valid = () => true
  own.queue = Promise.resolve({ flush } as unknown as SessionInputOutbox)
  const input = { id: 'refused-local', accountId: 'owner', deviceId: 'host', sessionId: 'session', text: 'local refused input', createdAt: 1,
    queued: true, failure: { code: 'send-failed' as const, message: 'Provider login expired' } }
  own.rows = [input]
  harness = createReactHarness()
  harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column'
  await renderWithAppProviders(harness, <SessionConversation timeline={emptyAgentWatchTimeline()} deviceId="host" sessionId="session" agentName="Agent" nativeRecord
    sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} footerNotice={<SessionInputQueue sessionId="session" waitingForConnection={false} />} />, { contacts: {} })
  await until('the connected host refusal is visible', () => !!harness.container.querySelector('[data-native-input-id="refused-local"] [data-send-state="failed"]'))
  const status = harness.container.querySelector('[data-native-input-id="refused-local"] [data-send-state="failed"]')!
  expect(status.textContent).toContain('Provider login expired')
  expect(harness.container.querySelector('[data-queued-prompt-id="refused-local"]')).toBeNull()
  expect(own.rows).toEqual([input])
  await page.getByRole('button', { name: translateSessionMessage('transcript.retrySend'), exact: true }).click()
  expect(flush).toHaveBeenCalledWith(true)
})

it('applies viewport geometry through CSS without rerendering the retained page', async () => {
  await page.viewport(390, 844)
  let renders = 0
  function RetainedPage() { renders++; return <div>Existing conversation</div> }
  harness = createReactHarness()
  await renderWithAppProviders(harness, <PhoneViewportShell mobile><RetainedPage /></PhoneViewportShell>, { contacts: {} })
  const shell = harness.container.querySelector('.gg-phone-viewport-shell')!
  await until('shell follows the initial native viewport', () => shell.getBoundingClientRect().height === 844)
  const initialRenders = renders
  await page.viewport(390, 500)
  await until('CSS receives the smaller native viewport', () => shell.getBoundingClientRect().height === 500)
  expect(renders).toBe(initialRenders)
  await page.viewport(390, 844)
  await until('CSS restores the full viewport', () => shell.getBoundingClientRect().height === 844)
  expect(renders).toBe(initialRenders)
})


it.each((['accepted', 'failed'] as const).flatMap(result => (['unchanged', 'shared-prefix', 'append', 'clear', 'closed'] as const).map(edit => ({ result, edit }))))('settles the shared draft across composer mounts ($result / $edit)', async ({ result, edit }) => {
  await page.viewport(390, 844)
  const own = state()
  own.accountId = 'owner'; own.rows = EMPTY; own.valid = () => true
  const drafts: Record<string, string> = {}
  const capture = phoneDraftTrace.begin(`${result}/${edit}`, () => drafts['session:host/session'] ?? '')
  onTestFailed(() => phoneDraftTrace.report(capture))
  const setDraft = (key: string, update: string | ((text: string) => string)) => {
    phoneDraftTrace.note('store.write.before', { key, previous: drafts[key], update: typeof update === 'string' ? update : 'functional' }, true)
    drafts[key] = typeof update === 'function' ? update(drafts[key] ?? '') : update
    phoneDraftTrace.note('store.write.after', { key, text: drafts[key] })
  }
  let commit!: () => void
  const durable = new Promise<void>(resolve => { commit = resolve })
  const send = vi.fn(async (text: string) => {
    await durable
    if (result === 'failed') throw Error('storage unavailable')
    own.rows = [{ id: 'remount', accountId: 'owner', deviceId: 'host', sessionId: 'session', text, createdAt: 1, queued: true, sendQueue: { order: 1 } }]
    changed()
  })
  harness = createReactHarness()
  harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column'
  const render = (epoch: number | null) => {
    const store = chatStore({ drafts, setDraft })
    phoneDraftTrace.note('fixture.render', { epoch, setDraft: phoneDraftTrace.id(store.setDraft), mentions: phoneDraftTrace.id(store.setDraftMentions), attachments: phoneDraftTrace.id(store.setDraftAttachments) })
    return renderWithAppProviders(harness, epoch === null ? null : <SessionConversation key={epoch} timeline={emptyAgentWatchTimeline()} deviceId="host" sessionId="session" agentName="Agent" nativeRecord
    sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={send} pendingSends={[]} sending={false} agentWorking
    onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} />, { contacts: {}, chat: store })
  }
  await render(1)
  await page.getByTestId('prompt-editor').fill('Hi')
  await page.getByRole('button', { name: translateSessionMessage('composer.sendMessage'), exact: true }).click()
  await until('the original composer awaits durable custody', () => send.mock.calls.length === 1)
  await render(null)
  expect(drafts['session:host/session']).toBe('Hi')
  const live = edit === 'shared-prefix' ? 'Hi again' : edit === 'append' ? 'Hi appended' : edit === 'clear' ? '' : 'Hi'
  if (edit !== 'closed') {
    await render(2)
    expect(page.getByTestId('prompt-editor').element().textContent).toBe('Hi')
    phoneDraftTrace.observeEditor(page.getByTestId('prompt-editor').element())
    if (edit === 'clear') {
      // fill('') uses separate DOM selection/delete commands; use the real editor keymap.
      // The same AllSelection path is exercised in input-area-hidden-empty.test.tsx.
      await page.getByTestId('prompt-editor').click()
      const modifier = /Mac/.test(navigator.platform) ? 'Meta' : 'Control'
      await userEvent.keyboard(`{${modifier}>}a{/${modifier}}{Backspace}`)
    } else await page.getByTestId('prompt-editor').fill(live)
    await until('the edit reaches both the real document and DOM before settling the send', () => {
      const editor = page.getByTestId('prompt-editor').element()
      return readComposer(editor) === live && editor.textContent === live
    })
  }
  phoneDraftTrace.note('commit.release')
  await act(async () => { commit(); await send.mock.results[0].value.catch(() => {}) })
  phoneDraftTrace.note('commit.settled')
  await render(2)
  if (result === 'accepted') await until('the committed input is visible after reopening', () => !!harness.container.querySelector('[data-queued-prompt-id="remount"]'))
  else expect(own.rows).toHaveLength(0)
  expect(page.getByTestId('prompt-editor').element().textContent).toBe(result === 'accepted' && live === 'Hi' ? '' : live)
  expect(send).toHaveBeenCalledTimes(1)
})


it.each((['phone', 'native'] as const).flatMap(mode => ['', 'Hi again', 'Hi appended'].map(text => ({ mode, text }))))('keeps input that advances before draft hydration ($mode / $text)', async ({ mode, text }) => {
  await page.viewport(mode === 'phone' ? 390 : 1000, 844)
  localStorage.removeItem('gugu.native-offline-draft:owner/host/hydrate')
  let pulse!: () => void
  function AfterInput({ active }: { active: boolean }) {
    useLayoutEffect(() => {
      if (active) {
        const editor = document.querySelector('[data-testid="prompt-editor"]')!
        writeComposer(editor, text)
        expect(readComposer(editor)).toBe(text)
        expect(editor.textContent).toBe(text)
      }
    }, [active])
    return null
  }
  function Fixture() {
    const [active, setActive] = useState(false)
    pulse = () => setActive(true)
    return <><SessionConversation timeline={emptyAgentWatchTimeline()} deviceId="host" sessionId="hydrate" agentName="Agent" nativeRecord
      sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking
      onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} /><AfterInput active={active} /></>
  }
  Object.assign(state(), { accountId: 'owner', rows: EMPTY, valid: () => true })
  harness = createReactHarness()
  harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column'
  await renderWithAppProviders(harness, <Fixture />, { contacts: {} })
  await page.getByTestId('prompt-editor').fill('different')
  await act(async () => { writeComposer(page.getByTestId('prompt-editor').element(), 'Hi'); pulse() })
  expect(page.getByTestId('prompt-editor').element().textContent).toBe(text)
})
