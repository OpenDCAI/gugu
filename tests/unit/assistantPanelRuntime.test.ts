import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAssistantPanelRuntime } from '../../apps/desktop/electron/sessionpage/assistant-panel-runtime'

// Drive the explicit library/integration callbacks without fixture filesystem events starting an unrelated full publication.
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(),
  watch: () => ({ on() { return this }, close() {} }),
}))

const calls = vi.hoisted(() => ({ signals: [] as AbortSignal[],domains:[] as string[],assistants:[] as string[],rpcNames:[] as string[],holdRpc:null as string|null,commitPublication:false,live:true,readable:false,stalled:true,collectIntegrations: false,blockedDomain:null as string|null,hold: null as Promise<void> | null }))
vi.mock('../../apps/desktop/electron/sessionpage/assistant-panel-admission',async importOriginal=>{
  const original=await importOriginal<typeof import('../../apps/desktop/electron/sessionpage/assistant-panel-admission')>()
  return {...original,
    prepareAssistantPanelAdmission:(input:Parameters<typeof original.prepareAssistantPanelAdmission>[0])=>calls.stalled ? original.prepareAssistantPanelAdmission(input) : Promise.resolve({text:'',accepted:async()=>{}}),
    applyAssistantPanelPending:(input:Parameters<typeof original.applyAssistantPanelPending>[0])=>calls.readable ? original.applyAssistantPanelPending(input) : Promise.resolve({revision:'0',settledFailure:false,superseded:false}),
  }
})
vi.mock('../../apps/desktop/electron/sessionpage/assistant-panel-publisher',()=>({collectAssistantPanelFiles:async()=>[],publishAssistantPanelCollection:async({domain,assistantId,cloud,collect}:{domain:string;assistantId:string;cloud:{commit:(id:string,change:unknown)=>Promise<unknown>};collect: (previous: never[]) => Promise<unknown>})=>{
  calls.domains.push(domain)
  calls.assistants.push(assistantId)
  if (calls.commitPublication) await cloud.commit(assistantId,{operationId:'operation',domain,key:'fixture',expectedRevision:'0',operation:'save',data:{}})
  if (domain === calls.blockedDomain) await calls.hold
  if (domain === 'integrations' && calls.collectIntegrations) { await collect([]); await calls.hold }
}}))
vi.mock('@gugu/core/cloud/supabase',() => ({ createGuguSupabaseClient: () => ({
  from: () => { const query = { select: () => query,eq: () => query,abortSignal: () => query,maybeSingle: async () => ({error:null,data:calls.live ? {id:'assistant'} : null}) }; return query },
  rpc(name: string) {
    calls.rpcNames.push(name)
    if (name === calls.holdRpc) return {abortSignal(signal:AbortSignal) {
      calls.signals.push(signal)
      return new Promise<never>((_resolve,reject) => { if(signal.aborted) reject(signal.reason); else signal.addEventListener('abort',()=>reject(signal.reason),{once:true}) })
    }}
    if (calls.readable || name === 'assistant_panel_snapshot') return { abortSignal: async () => ({ error: null,data:
      name === 'assistant_panel_pending' ? { revision: '0',changes: [],notices: [] }
        : name === 'assistant_panel_admit' ? { admitted: true,revision: '0' }
          : { version: 1,revision: '0',items: [],application: [] },
    }) }
    const never = Promise.withResolvers<never>()
    return { then: never.promise.then.bind(never.promise),abortSignal(signal: AbortSignal) {
      calls.signals.push(signal)
      signal.addEventListener('abort',() => never.reject(signal.reason),{ once: true })
      return never.promise
    } }
  },
}) }))
afterEach(() => { vi.useRealTimers(); calls.signals.length = 0; calls.domains.length=0; calls.assistants.length=0; calls.rpcNames.length=0; calls.holdRpc=null; calls.commitPublication=false; calls.live=true; calls.readable=false; calls.stalled=true; calls.collectIntegrations=false; calls.blockedDomain=null; calls.hold=null })

it('stops only the removed assistant timers and listeners and never recreates its cached binding',async()=>{
  vi.useFakeTimers();calls.stalled=false;calls.readable=true
  const cwd=await mkdtemp(join(tmpdir(),'panel-removed-'))
  const listeners=new Set<(owner:string,kind:'capabilities'|'devices')=>void>()
  const runtime=createAssistantPanelRuntime({getAuth:async()=>({accessToken:'fixture',userId:'owner'}),instanceId:()=> 'runtime',deviceId:async()=> 'device',
    local:{onLibraryChanged:(listener:(owner:string,kind:'capabilities'|'devices')=>void)=>{listeners.add(listener);return()=>listeners.delete(listener)}} as never,guguHome:cwd,kind:'computer',env:{},failed:vi.fn(),locale:()=> 'en-US'})
  try{
    await runtime.bind({sessionId:'old',assistantId:'removed',ownerId:'owner',cwd})
    await runtime.bind({sessionId:'other',assistantId:'live',ownerId:'owner',cwd})
    await vi.advanceTimersByTimeAsync(1000);calls.assistants.length=0
    runtime.remove('removed');runtime.remove('removed')
    for(const listener of listeners) listener('owner','capabilities')
    await runtime.publish('old');await vi.advanceTimersByTimeAsync(600_001)
    expect(calls.assistants.length).toBeGreaterThan(0)
    expect(new Set(calls.assistants)).toEqual(new Set(['live']))
    expect(listeners.size).toBe(1)
    await expect(runtime.bind({sessionId:'old',assistantId:'removed',ownerId:'owner',cwd})).rejects.toThrow('PANEL_IDENTITY_REMOVED')
    calls.assistants.length=0
    await runtime.bind({sessionId:'old',assistantId:'replacement',ownerId:'owner',cwd})
    await runtime.publish('old')
    expect(new Set(calls.assistants)).toEqual(new Set(['replacement']))
  }finally{runtime.dispose();await rm(cwd,{recursive:true,force:true})}
})

it('aborts a commit already in flight and sends no later domain or retry after removal',async()=>{
  vi.useFakeTimers();calls.readable=true;calls.stalled=false
  const f=await libraryFixture()
  try{
    calls.commitPublication=true;calls.holdRpc='assistant_panel_commit'
    const publication=f.runtime.publish('session')
    await vi.waitFor(()=>expect(calls.signals).toHaveLength(1))
    f.runtime.remove('assistant')
    expect(calls.signals[0]!.aborted).toBe(true)
    await publication
    const before=calls.rpcNames.length
    f.changed('owner','capabilities');await vi.advanceTimersByTimeAsync(600_001)
    expect(calls.rpcNames).toHaveLength(before)
    expect(calls.rpcNames.filter(name=>name==='assistant_panel_commit')).toHaveLength(1)
  }finally{await f.cleanup()}
})

it('requires fresh live identity evidence after an uncertain removal failure',async()=>{
  vi.useFakeTimers();const f=await libraryFixture()
  try{
    const first=f.runtime.pauseRemoval('assistant'),second=f.runtime.pauseRemoval('assistant')
    first(false);await f.runtime.publish('session');expect(calls.domains).toEqual([])
    second(false);calls.live=false;await f.runtime.publish('session');expect(calls.domains).toEqual([])
    calls.live=true;await f.runtime.publish('session');expect(calls.domains.length).toBeGreaterThan(0)
    f.runtime.pauseRemoval('assistant')(true);calls.domains.length=0
    await f.runtime.publish('session');await vi.advanceTimersByTimeAsync(600_001)
    expect(calls.domains).toEqual([])
  }finally{await f.cleanup()}
})

it('keeps the idle thirty-second pull to pending without admission or inventory publication',async () => {
  calls.readable=true
  const cwd=await mkdtemp(join(tmpdir(),'panel-idle-budget-'))
  vi.useFakeTimers()
  const runtime=createAssistantPanelRuntime({getAuth:async()=>({accessToken:'fixture',userId:'owner'}),instanceId:()=> 'runtime',deviceId:async()=> 'device',
    local:{} as never,guguHome:cwd,kind:'computer',env:{},failed:vi.fn(),locale:()=> 'zh-CN'})
  try {
    await runtime.bind({sessionId:'session',assistantId:'assistant',ownerId:'owner',cwd})
    await vi.advanceTimersByTimeAsync(1000)
    calls.rpcNames.length=0; calls.domains.length=0
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls.rpcNames).toEqual(['assistant_panel_pending'])
    expect(calls.domains).toEqual([])
  } finally {runtime.dispose();vi.useRealTimers();await rm(cwd,{recursive:true,force:true})}
})

it('prepares stale profiles at each actual personal-assistant turn, independently of native startup', async () => {
  calls.stalled = false
  const cwd = await mkdtemp(join(tmpdir(), 'panel-profile-review-')), memory = join(cwd, '.claude', 'memory')
  const runtime = createAssistantPanelRuntime({ getAuth: async () => ({ accessToken: 'fixture', userId: 'owner' }), instanceId: () => 'runtime', deviceId: async () => 'device', local: {} as never, guguHome: cwd, kind: 'computer', env: {}, failed: vi.fn(), locale: () => 'zh-CN' })
  try {
    await mkdir(memory, { recursive: true })
    await writeFile(join(memory, 'owner-profile.md'), '姓名：测试')
    await writeFile(join(memory, 'MEMORY.md'), '- [关于你](owner-profile.md) profile_rules: 2')
    await runtime.bind({ sessionId: 'session', assistantId: 'assistant', ownerId: 'owner', cwd })
    expect((await runtime.prepare('session', 'hi')).beforeText).toContain('读owner-profile.md：')
    expect((await runtime.prepare('session', 'hi')).beforeText).toContain('读owner-profile.md：')
    await writeFile(join(memory, 'MEMORY.md'), '- [关于你](owner-profile.md) profile_rules: 6')
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

async function libraryFixture() {
  calls.stalled=false
  const cwd=await mkdtemp(join(tmpdir(),'panel-library-publication-'))
  let changed:((owner:string,kind:'capabilities'|'devices')=>void)|undefined
  let integrationChanged:(()=>void)|undefined
  let schedulesChanged:(()=>void)|undefined
  const unsubscribe=vi.fn(),unsubscribeIntegrations=vi.fn(),unsubscribeSchedules=vi.fn()
  const runtime=createAssistantPanelRuntime({getAuth:async()=>({accessToken:'fixture',userId:'owner'}),instanceId:()=> 'runtime',deviceId:async()=> 'device',
    local:{onLibraryChanged:(listener:typeof changed)=>{changed=listener;return unsubscribe},onIntegrationsChanged:(listener:()=>void)=>{integrationChanged=listener;return unsubscribeIntegrations},onSchedulesChanged:(listener:()=>void)=>{schedulesChanged=listener;return unsubscribeSchedules}} as never,guguHome:cwd,kind:'computer',env:{},failed:vi.fn(),locale:()=> 'zh-CN'})
  await runtime.bind({sessionId:'session',assistantId:'assistant',ownerId:'owner',cwd})
  return {runtime,changed:(owner:string,kind:'capabilities'|'devices')=>changed?.(owner,kind),integrationChanged:()=>integrationChanged?.(),schedulesChanged:()=>schedulesChanged?.(),unsubscribe,unsubscribeIntegrations,unsubscribeSchedules,
    async cleanup(){runtime.dispose();await rm(cwd,{recursive:true,force:true})}}
}

it('shares one snapshot across the nine publication domains',async()=>{
  const f=await libraryFixture()
  try {
    calls.rpcNames.length=0
    await f.runtime.publish('session')
    expect(calls.rpcNames).toEqual(['assistant_panel_snapshot'])
    expect(calls.domains).toEqual(['memory','personality','files','skills','voice-notes','schedules','capabilities','device-notes','integrations'])
  }finally{await f.cleanup()}
})

it('publishes scheduler events in their independent domain and disposes the bridge',async()=>{
  vi.useFakeTimers();const f=await libraryFixture()
  try {
    await f.runtime.publish('session');calls.domains.length=0
    f.schedulesChanged();f.schedulesChanged()
    await vi.advanceTimersByTimeAsync(300)
    expect(calls.domains).toEqual(['schedules'])
    f.runtime.dispose();f.schedulesChanged()
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls.domains).toEqual(['schedules'])
    expect(f.unsubscribeSchedules).toHaveBeenCalledOnce()
  }finally{await f.cleanup()}
})

it('publishes a durable library change promptly without scanning unrelated panel collections',async()=>{
  vi.useFakeTimers()
  const f=await libraryFixture()
  try{
    await f.runtime.publish('session');calls.domains.length=0
    f.changed('other-owner','capabilities');await vi.advanceTimersByTimeAsync(300)
    expect(calls.domains).toEqual([])
    f.changed('owner','capabilities');f.changed('owner','capabilities')
    await vi.advanceTimersByTimeAsync(300)
    expect(calls.domains).toEqual(['capabilities'])
    f.changed('owner','devices');await vi.advanceTimersByTimeAsync(300)
    expect(calls.domains).toEqual(['capabilities','device-notes'])
    f.runtime.dispose();f.changed('owner','capabilities');await vi.advanceTimersByTimeAsync(1000)
    expect(calls.domains).toHaveLength(2);expect(f.unsubscribe).toHaveBeenCalledOnce()
  }finally{await f.cleanup()}
})

it('publishes externally completed authorizations through the same independent domain lane',async()=>{
  vi.useFakeTimers();const held=Promise.withResolvers<void>();calls.blockedDomain='memory';calls.hold=held.promise
  const f=await libraryFixture()
  try{
    const full=f.runtime.publish('session');await vi.advanceTimersByTimeAsync(1)
    f.integrationChanged();await vi.advanceTimersByTimeAsync(300)
    expect(calls.domains).toEqual(['memory','integrations'])
    held.resolve();await full;f.runtime.dispose();f.integrationChanged();await vi.advanceTimersByTimeAsync(1000)
    expect(f.unsubscribeIntegrations).toHaveBeenCalledOnce()
  }finally{held.resolve();await f.cleanup()}
})

it('does not queue library publication behind an unrelated slow collection',async()=>{
  vi.useFakeTimers();const held=Promise.withResolvers<void>();calls.blockedDomain='memory';calls.hold=held.promise
  const f=await libraryFixture()
  try{
    const full=f.runtime.publish('session');await vi.advanceTimersByTimeAsync(1)
    expect(calls.domains).toEqual(['memory'])
    f.changed('owner','capabilities');await vi.advanceTimersByTimeAsync(300)
    expect(calls.domains).toEqual(['memory','capabilities'])
    held.resolve();await full
  }finally{held.resolve();await f.cleanup()}
})

it('publishes again when a second library write arrives during the first publication',async()=>{
  vi.useFakeTimers();const held=Promise.withResolvers<void>()
  const f=await libraryFixture()
  try{
    await f.runtime.publish('session');calls.domains.length=0
    calls.blockedDomain='capabilities';calls.hold=held.promise
    f.changed('owner','capabilities');await vi.advanceTimersByTimeAsync(300)
    expect(calls.domains).toEqual(['capabilities'])
    f.changed('owner','capabilities');await vi.advanceTimersByTimeAsync(300)
    expect(calls.domains).toEqual(['capabilities'])
    held.resolve();await vi.advanceTimersByTimeAsync(300)
    expect(calls.domains).toEqual(['capabilities','capabilities'])
  }finally{held.resolve();await f.cleanup()}
})
