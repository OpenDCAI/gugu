// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react'
import type { Session } from '@supabase/supabase-js'
import type { AssistantMachine } from '@/session/renderer/features/assistant/assistant-machine-core'
import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
const world = vi.hoisted(() => ({ rpc: vi.fn(), subscribe: vi.fn((_owner: string,_event: string,_callback: () => void) => ({})), unsubscribe: vi.fn(), readBody: vi.fn() }))
vi.mock('@/lib/supabase',() => ({ identityDb: { rpc: (...args: unknown[]) => ({ abortSignal: () => world.rpc(...args) }) },chatDb: { rpc: vi.fn() } }))
vi.mock('@/lib/realtimeChannel',() => ({ subscribePrivateUserEventBus: world.subscribe,unsubscribePrivateUserEventBus: world.unsubscribe }))
vi.mock('@gugu/core/cloud/assistantPanelBodies',() => ({ readAssistantPanelBody: world.readBody,uploadAssistantPanelBody: vi.fn() }))
const harnesses: ReturnType<typeof createReactHarness>[] = []
afterEach(() => { for (const harness of harnesses.splice(0)) harness.cleanup(); delete (window as unknown as Record<string,unknown>).__GUGU_ASSISTANT_PANEL__ })
it('runs cloud reads and subscriptions in the shell across two module graphs and two React roots without sharing tokens', async () => {
  const session = (owner: string) => ({ user: { id: owner },access_token: `private-${owner}` }) as Session
  const item = { assistant_user_id: 'assistant',owner_user_id: 'owner',domain: 'memory' as const,resource_key: 'note',device_id: 'home',revision: '1',
    data: { relativePath: 'note.md' },body_item_id: 'body',body_sha256: 'a'.repeat(64),deleted_at: null,observed_at: null,updated_at: '2026-10-26' }
  const persona = { ...item,domain: 'personality',resource_key: 'instructions',data: { text: 'old' },body_item_id: null,body_sha256: null }
  world.rpc.mockImplementation(async (name,args) => ({ error: null,data:
    name === 'assistant_panel_resource' ? (args.p_domain === 'personality' ? persona : item)
    : name === 'assistant_panel_commit' || name === 'assistant_panel_notice' ? { operationId: args.p_operation_id ?? args.p_notice?.operationId,revision: '2',status: 'pending' }
    : { version: 1,revision: '1',items: [item,persona],application: [] } }))
  world.readBody.mockResolvedValue(new TextEncoder().encode('cloud memory'))
  const shellSession = await import('@/lib/sessionPublication')
  shellSession.publishRendererSession('SIGNED_IN',session('owner'))
  const host = await import('@/components/assistant/assistant-panel-host')
  host.installAssistantPanelHost()
  const shell = await import('@/components/assistant/assistant-panel-files')
  let shellMachine: AssistantMachine | undefined, paneMachine: AssistantMachine | undefined
  function Shell() { const machine = shell.useCloudAssistantFiles('assistant','chat','home'); useEffect(() => { shellMachine = machine },[machine]); return null }
  const first = createReactHarness(); harnesses.push(first); await first.render(createElement(Shell))
  expect(shellMachine?.panel).toBeDefined()
  // A second bundle has its own empty sessionPublication module and no AuthProvider.
  vi.resetModules()
  const paneSession = await import('@/lib/sessionPublication')
  expect(paneSession.getRendererSession()).toBeNull()
  const pane = await import('@/components/assistant/assistant-panel-files')
  function Pane() { const machine = pane.useCloudAssistantFiles('assistant','chat','home'); useEffect(() => { paneMachine = machine },[machine]); return null }
  const second = createReactHarness(); harnesses.push(second); await second.render(createElement(Pane))
  expect(paneMachine?.panel).toBeDefined()
  paneSession.publishRendererSession('SIGNED_IN',session('unrelated-module'))
  expect(paneMachine!.panel!.ownerId).toBe('owner')
  expect(await paneMachine!.panel!.body(item)).toEqual(new TextEncoder().encode('cloud memory'))
  expect(world.readBody.mock.calls.at(-1)![1]).toMatchObject({ token: 'private-owner',ownerId: 'owner',chatId: 'chat' })
  expect(world.subscribe).toHaveBeenCalledWith('owner','assistant_panel_changed',expect.any(Function))
  await paneMachine!.panel!.write(paneMachine!.panel!.paths.instructions,new TextEncoder().encode('New owner agreement'),'text/plain')
  expect(world.rpc).toHaveBeenCalledWith('assistant_panel_commit',expect.objectContaining({ p_data: { text: 'New owner agreement' } }))
  const paneBridge = await import('@/lib/assistantPanelBridge')
  await paneBridge.requireAssistantPanelBridge().queueNotice({ operationId: 'b0a1d3e5-0a9c-40d0-a590-bd83a795b389',resource: 'devices',operation: 'edited',id: 'device' },'assistant','owner')
  expect(world.rpc).toHaveBeenCalledWith('assistant_panel_notice',expect.objectContaining({ p_assistant: 'assistant' }))
  const changed = vi.fn(); window.addEventListener(pane.ASSISTANT_PANEL_CHANGED,changed)
  const callback = world.subscribe.mock.calls.at(-1)?.[2]
  expect(callback).toBeTypeOf('function')
  callback?.()
  window.removeEventListener(pane.ASSISTANT_PANEL_CHANGED,changed)
  expect(changed).toHaveBeenCalledOnce()
  expect(JSON.stringify(paneMachine)).not.toContain('private-owner')
  const old = paneMachine!.panel!
  await act(async () => { shellSession.publishRendererSession('SIGNED_OUT',null) })
  expect(paneMachine).toBeUndefined()
  await expect(old.snapshot()).rejects.toMatchObject({ code: 'account-changed' })
  expect(world.unsubscribe).toHaveBeenCalled()
})
