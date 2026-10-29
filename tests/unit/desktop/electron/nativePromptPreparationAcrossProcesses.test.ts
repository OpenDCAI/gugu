import { afterEach, expect, it, vi } from 'vitest'
import { setSessionAdmissionPreparation } from '../../../../apps/desktop/electron/session/main/core/sessions/session-admission-preparation'
import { createResourceChanges } from '../../../../apps/desktop/electron/sessionpage/assistant-resource-changes'

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
async function connect(runtime: Awaited<ReturnType<typeof runtimeGraph>>, timeoutMs?: number, hostDelayMs = 0) {
  if (!hostBridge || !runtime.bridge) return { stop: () => {} }
  const requested = new Set<(event: { sessionId: string; requestId: string }) => void>()
  const settled = new Set<(event: { requestId: string; accepted: boolean }) => void>()
  const worker = runtime.bridge.createHostPromptPreparation({
    request: event => { for (const listener of requested) listener(event) },
    settle: event => { for (const listener of settled) listener(event) },
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
  } as unknown as Parameters<typeof hostBridge.connectNativePromptPreparation>[0], { warn: () => {} })
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

afterEach(() => setSessionAdmissionPreparation(null))

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

it('sends the turn without a notice when the host answers too late, and the host releases it', async () => {
  const { accepted, rejected } = panel()
  const runtime = await runtimeGraph()
  const { stop } = await connect(runtime, 20, 60)
  const prepared = await runtime.prepareNativePrompt('session-a')
  expect(prepared?.beforeText).toBeUndefined()
  await vi.waitFor(() => expect(rejected).toHaveBeenCalledOnce())
  expect(accepted).not.toHaveBeenCalled()
  stop()
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
