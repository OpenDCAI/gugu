import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAssistantPanelRuntime } from '../../apps/desktop/electron/sessionpage/assistant-panel-runtime'

const calls = vi.hoisted(() => ({ signals: [] as AbortSignal[],domains:[] as string[], stalled:true }))
vi.mock('../../apps/desktop/electron/sessionpage/assistant-panel-admission',async importOriginal=>{
  const original=await importOriginal<typeof import('../../apps/desktop/electron/sessionpage/assistant-panel-admission')>()
  return {...original,prepareAssistantPanelAdmission:(input:Parameters<typeof original.prepareAssistantPanelAdmission>[0])=>calls.stalled ? original.prepareAssistantPanelAdmission(input) : Promise.resolve({text:'',accepted:async()=>{}})}
})
vi.mock('../../apps/desktop/electron/sessionpage/assistant-panel-publisher',()=>({collectAssistantPanelFiles:async()=>[],publishAssistantPanelCollection:async({domain}:{domain:string})=>{calls.domains.push(domain)}}))
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
afterEach(() => { vi.useRealTimers(); calls.signals.length = 0; calls.domains.length=0; calls.stalled=true })

it('aborts stalled cloud requests and releases admission after a bounded retry window', async () => {
  const cwd = await mkdtemp(join(tmpdir(),'panel-runtime-timeout-'))
  vi.useFakeTimers()
  const runtime = createAssistantPanelRuntime({ getAuth: async () => ({ accessToken: 'fixture',userId: 'owner' }),
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
  const runtime=createAssistantPanelRuntime({getAuth:async()=>({accessToken:'fixture',userId:'owner'}),instanceId:()=> 'runtime',deviceId:async()=> 'device',local:{} as never,guguHome:cwd,kind:'computer',env:{},failed:vi.fn()})
  try{
    await runtime.bind({sessionId:'session',assistantId:'assistant',ownerId:'owner',cwd})
    await runtime.publish('session')
    expect(calls.domains).toContain('memory')
    expect(calls.domains).not.toContain('tasks')
  }finally{runtime.dispose();await rm(cwd,{recursive:true,force:true})}
})
