import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAssistantPanelRuntime } from '../../apps/desktop/electron/sessionpage/assistant-panel-runtime'

const calls = vi.hoisted(() => ({ signals: [] as AbortSignal[],domains:[] as string[], stalled:true,collectIntegrations: false,hold: null as Promise<void> | null }))
vi.mock('../../apps/desktop/electron/sessionpage/assistant-panel-admission',async importOriginal=>{
  const original=await importOriginal<typeof import('../../apps/desktop/electron/sessionpage/assistant-panel-admission')>()
  return {...original,prepareAssistantPanelAdmission:(input:Parameters<typeof original.prepareAssistantPanelAdmission>[0])=>calls.stalled ? original.prepareAssistantPanelAdmission(input) : Promise.resolve({text:'',accepted:async()=>{}})}
})
vi.mock('../../apps/desktop/electron/sessionpage/assistant-panel-publisher',()=>({collectAssistantPanelFiles:async()=>[],publishAssistantPanelCollection:async({domain,collect}:{domain:string;collect: (previous: never[]) => Promise<unknown>})=>{
  calls.domains.push(domain)
  if (domain === 'integrations' && calls.collectIntegrations) { await collect([]); await calls.hold }
}}))
vi.mock('@gugu/core/cloud/supabase',() => ({ createGuguSupabaseClient: () => ({
  rpc() {
    const never = Promise.withResolvers<never>()
    return { then: never.promise.then.bind(never.promise),abortSignal(signal: AbortSignal) {
      calls.signals.push(signal)
      signal.addEventListener('abort',() => never.reject(signal.reason),{ once: true })
      return never.promise
    } }
  },
}) }))
afterEach(() => { vi.useRealTimers(); calls.signals.length = 0; calls.domains.length=0; calls.stalled=true; calls.collectIntegrations=false; calls.hold=null })

it('prepares stale profiles at each actual personal-assistant turn, independently of native startup', async () => {
  calls.stalled = false
  const cwd = await mkdtemp(join(tmpdir(), 'panel-profile-review-')), memory = join(cwd, '.claude', 'memory')
  const runtime = createAssistantPanelRuntime({ getAuth: async () => ({ accessToken: 'fixture', userId: 'owner' }), instanceId: () => 'runtime', deviceId: async () => 'device', local: {} as never, guguHome: cwd, kind: 'computer', env: {}, failed: vi.fn(), locale: () => 'zh-CN' })
  try {
    await mkdir(memory, { recursive: true })
    await writeFile(join(memory, 'owner-profile.md'), '姓名：测试')
    await writeFile(join(memory, 'MEMORY.md'), '- [关于你](owner-profile.md) profile_rules: 2')
    await runtime.bind({ sessionId: 'session', assistantId: 'assistant', ownerId: 'owner', cwd })
    expect((await runtime.prepare('session', 'hi')).beforeText).toContain('先读owner-profile.md再整理')
    expect((await runtime.prepare('session', 'hi')).beforeText).toContain('先读owner-profile.md再整理')
    await writeFile(join(memory, 'MEMORY.md'), '- [关于你](owner-profile.md) profile_rules: 5')
    expect((await runtime.prepare('session', 'hi')).text).toBe('')
  } finally { runtime.dispose(); await rm(cwd, { recursive: true, force: true }) }
})

it('aborts stalled cloud requests and releases admission after a bounded retry window', async () => {
  const cwd = await mkdtemp(join(tmpdir(),'panel-runtime-timeout-'))
  vi.useFakeTimers()
  const runtime = createAssistantPanelRuntime({ locale: () => 'zh-CN',getAuth: async () => ({ accessToken: 'fixture',userId: 'owner' }),
    instanceId: () => 'runtime',deviceId: async () => 'device',local: {} as never,guguHome: cwd,kind: 'computer',env: {},failed: vi.fn(),
  })
  try {
    await runtime.bind({ sessionId: 'session',assistantId: 'assistant',ownerId: 'owner',cwd })
    let outcome = 'waiting'
    const preparation = runtime.prepare('session','hello').then(() => { outcome = 'admitted' },() => { outcome = 'unavailable' })
    await vi.advanceTimersByTimeAsync(7000)
    expect(outcome).toBe('unavailable')
    await preparation
    expect(calls.signals).toHaveLength(3)
    expect(calls.signals.every(signal => signal.aborted)).toBe(true)
  } finally { runtime.dispose(); vi.useRealTimers(); await rm(cwd,{ recursive: true,force: true }) }
})

it('publishes the other panel domains without a second device task directory',async()=>{
  calls.stalled=false
  const cwd=await mkdtemp(join(tmpdir(),'panel-no-task-snapshot-'))
  const runtime=createAssistantPanelRuntime({getAuth:async()=>({accessToken:'fixture',userId:'owner'}),instanceId:()=> 'runtime',deviceId:async()=> 'device',local:{} as never,guguHome:cwd,kind:'computer',env:{},failed:vi.fn(),locale:()=> 'zh-CN'})
  try{
    await runtime.bind({sessionId:'session',assistantId:'assistant',ownerId:'owner',cwd})
    await runtime.publish('session')
    expect(calls.domains).toContain('memory')
    expect(calls.domains).not.toContain('tasks')
  }finally{runtime.dispose();await rm(cwd,{recursive:true,force:true})}
})

it('publishes completed verification even when it finishes during the previous publication',async () => {
  calls.stalled = false; calls.collectIntegrations = true
  const held = Promise.withResolvers<void>(); calls.hold = held.promise
  const collected = Promise.withResolvers<void>()
  let verified: (() => void) | undefined
  const integrations = vi.fn(async (_owner: string,onVerified?: () => void) => { verified = onVerified; collected.resolve(); return [] })
  const cwd = await mkdtemp(join(tmpdir(),'panel-verification-publication-'))
  vi.useFakeTimers()
  const failed = vi.fn()
  const runtime = createAssistantPanelRuntime({ getAuth: async () => ({ accessToken: 'fixture',userId: 'owner' }),instanceId: () => 'runtime',deviceId: async () => 'device',
    local: { integrationCatalog: () => [],integrations } as never,guguHome: cwd,kind: 'computer',env: {},failed,locale: () => 'zh-CN' })
  try {
    await runtime.bind({ sessionId: 'session',assistantId: 'assistant',ownerId: 'owner',cwd })
    const first = runtime.publish('session')
    await collected.promise
    expect(verified).toBeTypeOf('function')
    verified!(); held.resolve()
    await first
    await vi.advanceTimersByTimeAsync(250)
    expect(integrations).toHaveBeenCalledTimes(2)
    expect(failed).not.toHaveBeenCalled()
    runtime.dispose(); verified!()
    await vi.advanceTimersByTimeAsync(1000)
    expect(integrations).toHaveBeenCalledTimes(2)
  } finally { held.resolve(); runtime.dispose(); vi.useRealTimers(); await rm(cwd,{ recursive: true,force: true }) }
})
