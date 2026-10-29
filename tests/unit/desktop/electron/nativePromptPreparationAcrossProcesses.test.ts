import { afterEach, expect, it, vi } from 'vitest'
import { setSessionAdmissionPreparation } from '../../../../apps/desktop/electron/session/main/core/sessions/session-admission-preparation'
import { prepareAgentScheduleChanges } from '../../../../apps/desktop/electron/session/main/core/automations/assistant-panel-schedule-preparation'
import { createResourceChanges } from '../../../../apps/desktop/electron/sessionpage/assistant-resource-changes'

// The assistant's main session has schedules, so the minute scheduler prepares it too.
vi.mock('../../../../apps/desktop/electron/session/main/core/automations/repo', () => ({ listAutomations: async () => [{ agentSessionId: 'session-a' }] }))

// Loaded once, in the host's module graph (before any reset). Absent before #881's bridge existed,
// so the same file shows what a runtime turn received without it.
const hostBridge = await import('../../../../apps/desktop/electron/session/main/core/acp/runtime-process/native-prompt-preparation').catch(() => null)

// The ACP runtime (SessionCell) runs in its own process. The host installs the assistant panel's
// preparation in its module graph; the runtime's copy of the module is a different instance.
async function runtimeGraph() {
  vi.resetModules()
  const preparation = await import('../../../../packages/session-runtime/src/acp-agents/session/prompt-preparation')
  const bridge = await import('../../../../packages/session-runtime/src/acp-agents/session/host-prompt-preparation').catch(() => null)
  return { ...preparation, bridge }
}

/** The runtime contract's four preparation entries over an in-memory link, as boot.ts and host.ts wire them. */
async function connect(runtime: Awaited<ReturnType<typeof runtimeGraph>>, timeoutMs?: number, hostDelayMs = 0,
  warn: (message: string, detail?: Record<string, unknown>) => void = () => {}) {
  if (!hostBridge || !runtime.bridge) return { stop: () => {} }
  const requested = new Set<(event: { sessionId: string; requestId: string }) => void>()
  const settled = new Set<(event: { requestId: string; accepted: boolean }) => void>()
  const worker = runtime.bridge.createHostPromptPreparation({
    request: event => { for (const listener of requested) listener(event) },
    settle: event => { for (const listener of settled) listener(event) },
    warn,
    ...(timeoutMs ? { timeoutMs } : {}),
  })
  const stop = await hostBridge.connectNativePromptPreparation({
    nativePromptPreparationRequested: { subscribe: async (_key: undefined, { onEvent }: { onEvent: (event: { sessionId: string; requestId: string }) => void }) => {
      requested.add(onEvent); return () => { requested.delete(onEvent) } } },
    nativePromptPreparationSettled: { subscribe: async (_key: undefined, { onEvent }: { onEvent: (event: { requestId: string; accepted: boolean }) => void }) => {
      settled.add(onEvent); return () => { settled.delete(onEvent) } } },
    enableNativePromptPreparation: async () => worker.enable(),
    resolveNativePromptPreparation: async (input: Parameters<typeof worker.resolve>[0]) => {
      if (hostDelayMs) await new Promise(resolve => setTimeout(resolve, hostDelayMs))
      return worker.resolve(input)
    },
  } as unknown as Parameters<typeof hostBridge.connectNativePromptPreparation>[0], { warn })
  return { stop }
}

function panel() {
  const accepted = vi.fn(async () => {}), rejected = vi.fn(async () => {}), asked = vi.fn()
  setSessionAdmissionPreparation(async (sessionId, text) => {
    asked(sessionId)
    return sessionId === 'session-a'
      ? { text, beforeText: '<resource_changes>\n飞书已连接，要用就派任务\n</resource_changes>', accepted, rejected, assistantPanel: true }
      : { text, accepted: async () => {} }
  })
  return { accepted, rejected, asked }
}

/** The assistant's real change journal behind the panel preparation, as the host installs it. */
async function assistantJournal() {
  let saved: Parameters<Parameters<typeof createResourceChanges>[1]['save']>[0] | null = null
  const journal = createResourceChanges('owner', { load: async () => saved, save: async state => { saved = structuredClone(state) } })
  const use = { note: '飞书已连接，要用就派任务', delegate: { tool: 'session_spawn' }, task_skills: ['lark-calendar'] }
  const inventory = (apps: string[]) => [
    JSON.stringify({ account: 'user:owner' }),
    JSON.stringify({ device_id: 'device:cloud', label: '助理', online: true, this_machine: true }),
    JSON.stringify({ source: 'integrations', device: 'device:cloud', status: 'read', items: apps.map(id => ({ id: `${id}:default`, name: '飞书', modifiedAt: '2026-10-29T07:38:13Z', use })) }),
  ]
  setSessionAdmissionPreparation(async (sessionId, text) => {
    if (sessionId !== 'session-a') return { text, accepted: async () => {} }
    const changes = await journal.prepare()
    return { text, ...(changes.text ? { beforeText: changes.text } : {}), accepted: changes.accepted, rejected: changes.rejected, assistantPanel: true }
  })
  return { journal, inventory, saved: () => saved! }
}

afterEach(() => { setSessionAdmissionPreparation(null); vi.useRealTimers() })

it('delivers the notice the host prepared for a bound assistant session to that session\'s turn in the runtime process', async () => {
  const { accepted, asked } = panel()
  const runtime = await runtimeGraph()
  const { stop } = await connect(runtime)
  const prepared = await runtime.prepareNativePrompt('session-a')
  // The id the panel bound is the id the turn asks with.
  expect(asked).toHaveBeenCalledWith('session-a')
  expect(prepared?.beforeText).toContain('飞书已连接，要用就派任务')
  await prepared!.accepted()
  await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
  stop()
})

it('releases the notice when the provider request is abandoned, and leaves other sessions\' text unchanged', async () => {
  const { accepted, rejected } = panel()
  const runtime = await runtimeGraph()
  const { stop } = await connect(runtime)
  const prepared = await runtime.prepareNativePrompt('session-a')
  await prepared!.rejected!()
  await vi.waitFor(() => expect(rejected).toHaveBeenCalledOnce())
  expect(accepted).not.toHaveBeenCalled()
  const other = await runtime.prepareNativePrompt('session-b')
  expect(other?.beforeText).toBeUndefined()
  expect(other?.text).toBe('')
  stop()
})

it('sends the turn without a notice when the host answers too late, says so, and the host releases it', async () => {
  const { accepted, rejected } = panel()
  const warn = vi.fn()
  const runtime = await runtimeGraph()
  const { stop } = await connect(runtime, 20, 60, warn)
  const prepared = await runtime.prepareNativePrompt('session-a')
  expect(prepared?.beforeText).toBeUndefined()
  await vi.waitFor(() => expect(rejected).toHaveBeenCalledOnce())
  expect(accepted).not.toHaveBeenCalled()
  // Never silently: the runtime that stopped waiting and the host that answered late both leave a line.
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'), expect.objectContaining({ sessionId: 'session-a' }))
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('after the turn'), expect.objectContaining({ sessionId: 'session-a' }))
  stop()
})

it('sends a long turn\'s notice once, and records it when that turn reports it was sent (panel input)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const { journal, inventory, saved } = await assistantJournal()
  await journal.observe(inventory([])); await journal.full(0); await journal.observe(inventory(['feishu']))
  const runtime = await runtimeGraph()
  const { stop } = await connect(runtime)
  const typed = await runtime.prepareNativePrompt('session-a')
  expect(typed?.beforeText).toContain('飞书已连接，要用就派任务')
  // The model is still answering that turn half a minute later when the next preparation runs.
  vi.setSystemTime(Date.now() + 31_000)
  const meanwhile = await runtime.prepareNativePrompt('session-a')
  expect(meanwhile?.beforeText).toBeUndefined()
  await meanwhile!.accepted()
  await typed!.accepted()
  await vi.waitFor(() => expect(saved().delivered).toBe(saved().version))
  expect((await runtime.prepareNativePrompt('session-a'))?.beforeText).toBeUndefined()
  stop()
})

it('carries the notice on a chat delivery that arrives right after the minute scheduler prepared the session', async () => {
  const { journal, inventory, saved } = await assistantJournal()
  await journal.observe(inventory([])); await journal.full(0); await journal.observe(inventory(['feishu']))
  const runtime = await runtimeGraph()
  const { stop } = await connect(runtime)
  // Applies saved schedule changes before the scheduler's tick; it sends nothing to the model.
  expect((await prepareAgentScheduleChanges()).size).toBe(0)
  const delivered = await runtime.prepareNativePrompt('session-a')
  expect(delivered?.beforeText).toContain('飞书已连接，要用就派任务')
  await delivered!.accepted()
  await vi.waitFor(() => expect(saved().delivered).toBe(saved().version))
  stop()
})

it('returns the notice to the next turn when its turn fails, its runtime exits, or it never reports', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const { journal, inventory, saved } = await assistantJournal()
  await journal.observe(inventory([])); await journal.full(0); await journal.observe(inventory(['feishu']))
  let runtime = await runtimeGraph()
  let link = await connect(runtime)
  const failed = await runtime.prepareNativePrompt('session-a')
  expect(failed?.beforeText).toContain('飞书已连接')
  await failed!.rejected!()
  const exiting = await runtime.prepareNativePrompt('session-a')
  expect(exiting?.beforeText).toContain('飞书已连接')
  // The runtime process exits in the middle of that turn; the host takes it back.
  link.stop()
  runtime = await runtimeGraph(); link = await connect(runtime)
  const hung = await runtime.prepareNativePrompt('session-a')
  expect(hung?.beforeText).toContain('飞书已连接')
  // That turn never reports; its hold ends after ten minutes.
  vi.setSystemTime(Date.now() + 10 * 60_000 + 1_000)
  const next = await runtime.prepareNativePrompt('session-a')
  expect(next?.beforeText).toContain('飞书已连接')
  await next!.accepted()
  await vi.waitFor(() => expect(saved().delivered).toBe(saved().version))
  link.stop()
})

it('withdraws a disconnected application in the next turn of a resumed session, and does not repeat it', async () => {
  let saved: Parameters<Parameters<typeof createResourceChanges>[1]['save']>[0] | null = null
  const journal = createResourceChanges('owner', { load: async () => saved, save: async state => { saved = structuredClone(state) } })
  const use = { note: '飞书已连接，要用就派任务', delegate: { tool: 'session_spawn' }, task_skills: ['lark-calendar'] }
  const inventory = (apps: string[]) => [
    JSON.stringify({ account: 'user:owner' }),
    JSON.stringify({ device_id: 'device:cloud', label: '助理', online: true, this_machine: true }),
    JSON.stringify({ source: 'integrations', device: 'device:cloud', status: 'read', items: apps.map(id => ({ id: `${id}:default`, name: '飞书', modifiedAt: '2026-10-29T07:38:13Z', use })) }),
  ]
  // The session opened with Feishu connected and its route already delivered.
  await journal.observe(inventory(['feishu'])); await journal.full(0)
  setSessionAdmissionPreparation(async (_sessionId, text) => {
    const changes = await journal.prepare()
    return { text, ...(changes.text ? { beforeText: changes.text } : {}), accepted: changes.accepted, rejected: changes.rejected, assistantPanel: true }
  })
  const runtime = await runtimeGraph()
  const { stop } = await connect(runtime)
  // Feishu disappears from the connection state while the session keeps resuming.
  await journal.observe(inventory([]))
  const next = await runtime.prepareNativePrompt('session-a')
  expect(next?.beforeText).toContain('<resource_changes>')
  expect(next?.beforeText).toContain('"op":"-"')
  expect(next?.beforeText).toContain('已断开')
  await next!.accepted()
  await vi.waitFor(() => expect(saved!.delivered).toBe(saved!.version))
  const after = await runtime.prepareNativePrompt('session-a')
  expect(after?.beforeText).toBeUndefined()
  stop()
})

it('asks nothing until the host enables preparation', async () => {
  panel()
  const runtime = await runtimeGraph()
  expect(runtime.prepareNativePrompt('session-a')).toBeNull()
})
