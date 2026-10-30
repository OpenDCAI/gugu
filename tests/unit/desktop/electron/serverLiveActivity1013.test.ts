import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acpRuntimeApiContract } from '@gugu/session-core/acp'
import { createEventStreamHost, withValidation } from '@gugu/session-wire'
import { createTestWire } from '@gugu/session-wire/testing'
import { createScope } from '@gugu/session-wire/util'
import { noopLogger } from '@gugu/session-shared/logger'
import { makeAcpHarness, makeStartInput } from '../../../../packages/session-runtime/src/acp-agents/acp-test-support'
import { AcpRuntime } from '../../../../packages/session-runtime/src/acp-agents/runtime/runtime'
import { createAcpRuntimeController } from '../../../../packages/session-runtime/src/acp-agents/api/controller'
import { createHostPromptPreparation } from '../../../../packages/session-runtime/src/acp-agents/session/host-prompt-preparation'
import { ChildAcpProcessHost } from '../../../../packages/session-runtime/src/acp-agents/node/child-process-host'
import { LocalAttachmentStore } from '../../../../packages/session-runtime/src/acp-agents/node/local-attachment-store'
import { LocalPromptQueueStore } from '../../../../packages/session-runtime/src/acp-agents/node/local-prompt-queue-store'
import { startServerAccountActivity } from '../../../../apps/desktop/electron/server/server-account-activity'
import { accountIsBusy, readAccountActivity } from '../../../../apps/desktop/electron/server/server-layout'
import { createServerVersionLifecycle } from '../../../../apps/desktop/electron/server/server-version-lifecycle'
import { createAccountVersionConverger } from '../../../../apps/desktop/electron/server/server-account-converge'
import { prepareAccountHandoff } from '../../../../apps/desktop/electron/server/server-account-handoff'
import { startPtyAttachServer } from '../../../../apps/desktop/electron/session/main/core/pty/attach/attach-server'
import { prepareSessionVersionHandoff } from '../../../../apps/desktop/electron/session/main/core/sessions/version-handoff'
import { recordDesktopReport, requestVersionRetry } from '../../../../packages/core/src/cloud/serverDesktopVersions'
import * as processOwnership from '../../../../apps/desktop/electron/session/main/core/sessions/session-process'

vi.mock('../../../../apps/desktop/electron/server/server-upgrade-guard', async original => ({
  ...await original<typeof import('../../../../apps/desktop/electron/server/server-upgrade-guard')>(),
  spawnUpgradeGuard: () => undefined,
}))
const { startServerUpdater } = await import('../../../../apps/desktop/electron/server/server-updater')
const root = path.resolve(__dirname, '../../../..')
const requireBuiltin = createRequire(import.meta.url)
const homes: string[] = []
const savedEnv = { ...process.env }
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  process.env = { ...savedEnv }
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})
function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-live-activity-'))
  homes.push(dir)
  return dir
}

function evaluate(source: string, context: Record<string, unknown>) {
  return runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { process, Buffer, console, Date, setTimeout, clearTimeout, setInterval, clearInterval, ...context })
}
/** Run the actual ownership-reading export, without booting unrelated Electron services. */
function exportedFunction(file: string, name: string, context: Record<string, unknown>) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  if (!fn) throw new Error(`Missing production function ${name}`)
  return evaluate(`(${fn.getText(source).replace(/^export /, '')})`, context)
}

function supervisorCall(name: string, context: Record<string, unknown>) {
  const file = path.join(root, 'apps/desktop/electron/server/server-supervisor.ts')
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  let call: ts.CallExpression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === name) call = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!call) throw new Error(`Missing production supervisor ${name} wiring`)
  return evaluate(call.getText(source), context)
}

/** Run node/boot.ts itself: the runtime, controller, child ownership and event wiring are production code. */
function bootRuntime(dir: string) {
  const h = makeAcpHarness({ acpBehavior: {
    buildSpawn: () => ({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], env: {} }),
    connect: (...args) => h.agent.behavior.connect(...args),
  } })
  const scope = createScope({ label: 'activity-guard' })
  let controller!: ReturnType<typeof createAcpRuntimeController>
  let runtime!: AcpRuntime
  const modules: Record<string, unknown> = {
    '@gugu/session-core/acp': { acpRuntimeApiContract },
    '@gugu/session-core/agents/plugins': { AgentPluginHost: class { constructor() { return h.deps.agentHost } } },
    '@gugu/session-core/agents/plugins/helpers': { createAgentHomeProvisioner: () => undefined, createLocalPluginFs: () => ({}) },
    '@gugu/session-core/exec': { NodeExecutionContext: class {} },
    '@gugu/session-shared/logger/node': { initProcessLogging: () => noopLogger },
    '@gugu/session-wire': { createEventStreamHost, withValidation },
    '@gugu/session-wire/util/process-runtime': {
      serveWorkerProcess: (factory: (s: typeof scope) => typeof controller) => { controller = factory(scope) },
      workerValidatePolicy: () => 'full',
    },
    '../api/controller': { createAcpRuntimeController: (...args: Parameters<typeof createAcpRuntimeController>) => {
      runtime = args[0]
      return createAcpRuntimeController(...args)
    } },
    '../session/host-prompt-preparation': { createHostPromptPreparation },
    '../runtime/runtime': { AcpRuntime },
    './child-process-host': { ChildAcpProcessHost },
    './local-attachment-store': { LocalAttachmentStore },
    './local-prompt-queue-store': { LocalPromptQueueStore },
  }
  const module = { exports: {} as { bootAcpRuntimeProcess: (options: unknown) => void } }
  evaluate(fs.readFileSync(path.join(root, 'packages/session-runtime/src/acp-agents/node/boot.ts'), 'utf8'), {
    module, exports: module.exports,
    require: (id: string) => id.startsWith('node:') ? requireBuiltin(id) : modules[id],
  })
  module.exports.bootAcpRuntimeProcess({ env: { GUGU_ACP_ATTACHMENTS_DIR: dir }, mergeEnvelopes: (texts: string[]) => texts.join('\n'), recoverDelivery: (text: string) => text })
  const wire = createTestWire(acpRuntimeApiContract, controller, { validate: 'full' })
  return { runtime, wire, scope }
}

describe('live ACP ownership reaches the real version-switch consumer', () => {
  it.runIf(process.platform !== 'win32')('keeps a real attached idle runtime view safe, then switches only after its child has exited and account recovery completes', async () => {
    const dir = home()
    const { runtime, wire, scope } = bootRuntime(dir)
    let publisher: ReturnType<typeof startServerAccountActivity> | undefined
    let socket: Awaited<ReturnType<typeof startPtyAttachServer>> | undefined
    const permits: Array<NonNullable<Awaited<ReturnType<typeof prepareAccountHandoff>>>> = []
    let stopUpdater = () => {}
    const listeners = new Set<() => void>()
    const unsubscribe = await wire.client.liveSessionsChanged.subscribe(undefined, { onEvent: () => { for (const f of listeners) f() } })
    const readAcpLiveSessionIds = exportedFunction('apps/desktop/electron/session/main/core/acp/runtime-process/host.ts', 'readAcpLiveSessionIds', {
      acpWorker: { peek: async () => ({ client: wire.client }) },
    }) as () => Promise<string[]>
    const activity = exportedFunction('apps/desktop/electron/session/main/embedded-boot.ts', 'sessionpageVersionSwitchActivity', {
      readAcpLiveSessionIds, hostSessionProcessIds: processOwnership.hostSessionProcessIds,
      integrationConnectionService: { hasPendingAuthorizations: () => false },
      hasSessionStartAdmission: () => false,
    }) as () => Promise<{ busy: boolean; busyAgents: number }>
    try {
      expect((await wire.client.startSession({ input: makeStartInput({ sessionId: 'runtime-view', sourceSessionId: 'persisted-task', cwd: dir }) })).success).toBe(true)
      expect(runtime.sessionsListLiveModel().states.list.snapshot().data).toEqual({})
      expect(runtime.getSessionState('runtime-view').isGenerating).toBe(false)
      const provenance = await wire.client.adapterProvenance({ sessionId: 'runtime-view' })
      expect(provenance?.pid).toBeTypeOf('number')
      expect(() => process.kill(provenance!.pid!, 0)).not.toThrow()
      expect(await readAcpLiveSessionIds()).toEqual(['runtime-view'])

      const version = '0.2.58-beta.100.1'
      const target = '0.2.58-beta.101.1'
      for (const v of [version, target]) {
        fs.mkdirSync(path.join(dir, 'versions', v, 'bin'), { recursive: true })
        fs.mkdirSync(path.join(dir, 'versions', v, 'app'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'versions', v, 'bin', 'gugu-server'), `#!${process.execPath}\nconst d=process.env.GUGU_TASK_HOST_USER_DATA;require('node:fs').mkdirSync(d,{recursive:true});require('node:fs').writeFileSync(require('node:path').join(d,'activity.json'),JSON.stringify({pid:process.pid,startedAt:Date.now(),at:Date.now(),busy:false,runtimeOwned:true}));setInterval(()=>{},1000)`, { mode: 0o700 })
      }
      fs.symlinkSync(`versions/${version}`, path.join(dir, 'current'))
      Object.assign(process.env, { GUGU_SERVER_HOME: dir, GUGU_TASK_HOST_APP_PATH: path.join(dir, 'versions', version, 'app'), GUGU_TASK_HOST_VERSION: version, GUGU_SERVER_SUPERVISED: '1' })
      const layout = { home: dir, versions: path.join(dir, 'versions'), version }
      const lifecycle = createServerVersionLifecycle({ layout })
      await lifecycle.stage(target, async () => {})
      expect(lifecycle.ready(target)).toBe(true)
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
      vi.stubGlobal('fetch', async () => new Response(`${target} ${'a'.repeat(64)} https://example.invalid/server.tar.gz\n`))
      const startedAt = Date.now()
      // Execute the actual SERVER_MODE main.ts block, including its bridge wiring.
      const main = ts.createSourceFile('main.ts', fs.readFileSync(path.join(root, 'apps/desktop/electron/main.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
      let block: ts.Statement | undefined
      const visit = (node: ts.Node) => {
        if (ts.isIfStatement(node) && node.expression.getText(main) === 'SERVER_MODE' && node.thenStatement.getText(main).includes('startServerAccountActivity')) block = node.thenStatement
        ts.forEachChild(node, visit)
      }
      visit(main)
      if (!block) throw new Error('Missing production account activity wiring')
      const mainContext = {
        app: { getPath: () => dir }, serverAuth: null, createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
        sessionHostBoot: Promise.resolve(),
        loadEmdashBridge: () => ({ sessionpageVersionSwitchActivity: activity, sessionpageBootFailures: () => [], onSessionpageAuthorizationActivityChange: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } } }),
        startServerAccountActivity: (options: Parameters<typeof startServerAccountActivity>[0]) => { publisher = startServerAccountActivity(options) },
      }
      await evaluate(`(async function () ${block.getText(main)})()`, mainContext)
      await publisher!.report()
      const busy = () => accountIsBusy(dir, Date.now(), { pid: process.pid, startedAt })
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'activity.json'), 'utf8'))).toMatchObject({ busy: true, busyAgents: 1 })
      const shutdown = vi.fn()
      const account = { userId: 'fixture-account', dataDir: dir, dir, homeDir: dir, email: null, addedAt: null, signedIn: true, signedOut: null }
      const kill = vi.fn()
      const children = new Map([[account.userId, { process: { pid: process.pid, kill }, startedAt, version }]])
      const context = {
        log: { info: vi.fn(), warn: vi.fn() }, shutdown, layout,
        CHILD_STOP_GRACE_MS: 30_000,
        lifecycle, accountIsBusy, readAccountActivity,
        listAccounts: () => [account], children,
        accountDataDir: () => dir, noteExitReason: vi.fn(), createAccountVersionConverger, startServerUpdater,
        prepareAccountHandoff: async (...args: Parameters<typeof prepareAccountHandoff>) => {
          const permit = await prepareAccountHandoff(...args)
          if (permit) permits.push(permit)
          return permit
        },
      }
      socket = await startPtyAttachServer(dir, { warn: () => {}, call: (_type, payload) => prepareSessionVersionHandoff(payload, activity) })
      // Both consumers use their real supervisor composition, including current-child identity.
      const versions = supervisorCall('createAccountVersionConverger', context) as ReturnType<typeof createAccountVersionConverger>
      recordDesktopReport(dir, { id: 'fixture-desktop', version: target, protocol: null })
      expect(requestVersionRetry({ GUGU_SERVER_MODE: '1', GUGU_TASK_HOST_USER_DATA: dir })).toBe(true)
      versions.converge([account])
      expect(kill).not.toHaveBeenCalled()
      stopUpdater = supervisorCall('startServerUpdater', { ...context, versions }) as () => void
      await vi.advanceTimersByTimeAsync(60_000)
      expect(shutdown).not.toHaveBeenCalled()
      expect(fs.readlinkSync(path.join(dir, 'current'))).toBe(`versions/${version}`)
      expect((await wire.client.stopSession({ sessionId: 'runtime-view' })).success).toBe(true)
      expect(runtime.adapterProvenance('runtime-view')).toBeNull()
      expect(() => process.kill(provenance!.pid!, 0)).toThrow()
      await publisher!.report()
      expect(busy()).toBe(false)
      versions.converge([account])
      await vi.waitFor(() => expect(kill).toHaveBeenCalledOnce())
      expect(context.log.info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ urgent: false }))
      // A late idle heartbeat from the child being stopped cannot cancel recovery ownership.
      await publisher!.report()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(shutdown).not.toHaveBeenCalled()
      children.delete(account.userId)
      // The fixture's process object is replaced in-process; actual account exit discards this gate.
      await Promise.all(permits.splice(0).map(permit => permit.release()))
      await vi.advanceTimersByTimeAsync(30_000)
      expect(shutdown).not.toHaveBeenCalled()
      // The replacement has the same fixture PID but a new birth; the old idle file cannot speak for it.
      children.set(account.userId, { process: { pid: process.pid, kill }, startedAt: Date.now(), version })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(shutdown).not.toHaveBeenCalled()
      publisher!.dispose()
      await evaluate(`(async function () ${block.getText(main)})()`, mainContext)
      await publisher!.report()
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
      expect(fs.readlinkSync(path.join(dir, 'current'))).toBe(`versions/${target}`)
    } finally {
      stopUpdater(); publisher?.dispose(); unsubscribe(); wire.dispose()
      await Promise.all(permits.splice(0).map(permit => permit.release()))
      await socket?.close()
      vi.useRealTimers()
      await scope.dispose()
    }
  })

  it('projects starting and lost ownership from the same cells, and host PTY ownership without turn-status guesses', async () => {
    const requested = Promise.withResolvers<void>()
    const admitted = Promise.withResolvers<{ sessionId: string }>()
    const changed = vi.fn()
    const h = makeAcpHarness({ onLiveSessionsChanged: changed })
    h.agent.newSession.mockImplementationOnce(() => { requested.resolve(); return admitted.promise })
    const runtime = new AcpRuntime(h.deps)
    try {
      const starting = runtime.startSession(makeStartInput())
      await requested.promise
      expect(runtime.liveSessionIds()).toEqual(['conv-1'])
      admitted.resolve({ sessionId: 'provider-session' })
      expect((await starting).success).toBe(true)
      expect(changed).toHaveBeenCalled()
      runtime.manager.onProcessClosed(runtime.adapterProvenance('conv-1')!.connectionKey, { exitCode: 1, signal: null, stderrTail: '' })
      expect(runtime.liveSessionIds()).toEqual([])
      processOwnership.recordSessionProcess('fixture-host', { home: 'host', start: 'fresh' })
      processOwnership.recordSessionProcess('fixture-tmux', { home: 'tmux', start: 'reattach' })
      expect(processOwnership.hostSessionProcessIds()).toEqual(['fixture-host'])
    } finally {
      processOwnership.forgetSessionProcess('fixture-host')
      processOwnership.forgetSessionProcess('fixture-tmux')
      await runtime.dispose()
    }
  })

  it('requires fresh positively known idle from the current process, including before the first heartbeat', () => {
    const dir = home()
    const now = 100_000
    const expected = { pid: process.pid, startedAt: 99_000 }
    expect(accountIsBusy(dir, now, expected)).toBe(true)
    for (const patch of [{ runtimeOwned: undefined }, { busy: null }, { busy: true }, { at: 1 }, { at: now + 1 }, { pid: process.pid + 1 }, { startedAt: 98_000 }]) {
      fs.writeFileSync(path.join(dir, 'activity.json'), JSON.stringify({ runtimeOwned: true, busy: false, at: now, ...expected, ...patch }))
      expect(accountIsBusy(dir, now, expected), JSON.stringify(patch)).toBe(true)
    }
    fs.writeFileSync(path.join(dir, 'activity.json'), JSON.stringify({ runtimeOwned: true, busy: false, at: now, ...expected }))
    expect(accountIsBusy(dir, now, expected)).toBe(false)
  })

  it('does not turn an unavailable worker read into idle and does not let a superseded read overwrite new ownership', async () => {
    const dir = home()
    const first = Promise.withResolvers<{ busy: boolean; busyAgents: number }>()
    let read = () => first.promise
    const publisher = startServerAccountActivity({ dataDir: dir, version: null, read: () => read(), subscribe: () => () => {}, warn: vi.fn() })
    try {
      await Promise.resolve()
      read = async () => ({ busy: true, busyAgents: 1 })
      const refreshed = publisher.report()
      first.resolve({ busy: false, busyAgents: 0 })
      await refreshed
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'activity.json'), 'utf8'))).toMatchObject({ busy: true, busyAgents: 1 })
      read = async () => { throw new Error('worker disconnected') }
      await publisher.report()
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'activity.json'), 'utf8')).busy).toBeNull()
      expect(accountIsBusy(dir)).toBe(true)
    } finally { publisher.dispose() }
  })

  it('a private runtime read rejection propagates while an absent worker is read without starting it', async () => {
    const peek = vi.fn().mockResolvedValue(null)
    const read = exportedFunction('apps/desktop/electron/session/main/core/acp/runtime-process/host.ts', 'readAcpLiveSessionIds', { acpWorker: { peek } }) as () => Promise<string[]>
    await expect(read()).resolves.toEqual([])
    peek.mockResolvedValue({ client: { liveSessionIds: () => Promise.reject(new Error('worker read failed')) } })
    await expect(read()).rejects.toThrow('worker read failed')
  })
})
