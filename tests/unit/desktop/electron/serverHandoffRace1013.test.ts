import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { spawnOwnedChild } from '@gugu/session-core/exec'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareAccountHandoff } from '../../../../apps/desktop/electron/server/server-account-handoff'
import { startPtyAttachServer } from '../../../../apps/desktop/electron/session/main/core/pty/attach/attach-server'
import * as attachProtocol from '../../../../apps/desktop/electron/session/main/core/pty/attach/attach-protocol'
import { beginSessionStartAdmission, hasSessionStartAdmission, prepareSessionVersionHandoff, withSessionStartAdmission } from '../../../../apps/desktop/electron/session/main/core/sessions/version-handoff'

const root = path.resolve(__dirname, '../../../..')
const homes: string[] = []
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

/** Execute the production host start wrapper, including its pre-preparation admission receipt. */
function startWrapper(startOnce: () => Promise<unknown>) {
  const file = ts.createSourceFile('host.ts', fs.readFileSync(path.join(root, 'apps/desktop/electron/session/main/core/acp/runtime-process/host.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  let arrow!: ts.Node
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'startSession') arrow = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(file)
  return runInNewContext(compile(`(${arrow.getText(file)})`), { withSessionStartAdmission, startOnce }) as () => Promise<unknown>
}

/** Load the actual bridge export table, main's callback and the actual attach-call dispatcher. */
function bridgedSocket(read: () => Promise<{ busy: boolean }>) {
  const embeddedFile = ts.createSourceFile('embedded.ts', fs.readFileSync(path.join(root, 'apps/desktop/electron/session/main/embedded-boot.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = embeddedFile.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'prepareSessionVersionHandoff')!
  const embedded = { prepareSessionVersionHandoff: runInNewContext(compile(`(${declaration.getText(embeddedFile).replace(/^export /, '')})`), {
    prepareVersionHandoff: prepareSessionVersionHandoff, sessionpageVersionSwitchActivity: read,
  }) }
  const bridge = { exports: {} }
  runInNewContext(compile(fs.readFileSync(path.join(root, 'apps/desktop/electron/sessionpage/emdash-main-bridge.ts'), 'utf8')), {
    module: bridge, exports: bridge.exports, require: (id: string) => id === '@main/embedded-boot' ? embedded : {},
  })
  const main = ts.createSourceFile('main.ts', fs.readFileSync(path.join(root, 'apps/desktop/electron/main.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  let handoff!: ts.Node
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(main) === 'emdash.startSessionPtyAttachServer') {
      const options = node.arguments[1] as ts.ObjectLiteralExpression
      handoff = (options.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(main) === 'handoff') as ts.PropertyAssignment).initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(main)
  const callback = runInNewContext(compile(`(${handoff.getText(main)})`), { emdash: bridge.exports })
  const socketModule = { exports: {} as { startSessionPtyAttachServer: (dir: string, options: unknown) => ReturnType<typeof startPtyAttachServer> } }
  runInNewContext(compile(fs.readFileSync(path.join(root, 'apps/desktop/electron/session/main/core/pty/attach/start-attach-server.ts'), 'utf8')), {
    module: socketModule, exports: socketModule.exports, process: { env: {} },
    require: (id: string) => {
      const modules: Record<string, unknown> = {
        '@main/lib/logger': { log: { info: () => {}, warn: () => {} } },
        '../server-browser-env': { installServerBrowserHelpers: () => {} },
        './attach-server': { startPtyAttachServer }, './attach-protocol': attachProtocol,
      }
      return modules[id]
    },
  })
  return (dir: string) => socketModule.exports.startSessionPtyAttachServer(dir, { handoff: callback })
}

describe('account handoff fences the real host admission boundary', () => {
  it('blocks switching during accepted host preparation, then refuses a new start after the same socket grants handoff', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-handoff-socket-'))
    homes.push(dir)
    const account = { dataDir: dir, email: null }
    const target = '0.2.58-beta.101.1'
    const pending = Promise.withResolvers<{ result: unknown }>()
    const start = startWrapper(() => pending.promise)
    const server = await bridgedSocket(async () => ({ busy: false }))(dir)
    let permit: Awaited<ReturnType<typeof prepareAccountHandoff>> = null
    try {
      const accepted = start()
      expect(hasSessionStartAdmission()).toBe(true)
      const busy = await prepareAccountHandoff(account, { pid: process.pid }, target)
      expect(busy?.busy).toBe(true)
      expect(busy?.valid()).toBe(false)
      pending.resolve({ result: 'admitted' })
      await expect(accepted).resolves.toBe('admitted')
      expect(hasSessionStartAdmission()).toBe(false)
      permit = await prepareAccountHandoff(account, { pid: process.pid }, target)
      expect(permit?.valid()).toBe(true)
      await expect(start()).rejects.toThrow('switching versions')
      await permit!.release()
      permit = null
      await expect(start()).resolves.toBe('admitted')
      // A stale PID's acknowledgement cannot authorise stopping the replacement account.
      expect(await prepareAccountHandoff(account, { pid: process.pid + 1 }, target)).toBeNull()
    } finally {
      pending.resolve({ result: 'admitted' })
      await permit?.release()
      // Release a possible wrong-PID reply at this test's real host boundary.
      // The next test uses no admission singleton state.
      await server.close()
    }
  })

  it('returns a rejected promise from the real PTY start wrapper when admission is closed', async () => {
    const source = ts.createSourceFile('local.ts', fs.readFileSync(path.join(root, 'apps/desktop/electron/session/main/core/sessions/impl/local-session.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
    let method!: ts.MethodDeclaration
    const visit = (node: ts.Node) => {
      if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'startSessionInternal') method = node
      ts.forEachChild(node, visit)
    }
    visit(source)
    const value = runInNewContext(compile(`({${method.getText(source).replace(/^private /, '')}})`), {
      beginSessionStartAdmission, makePtySessionId: () => 'fixture',
    }) as { startSessionInternal(...args: unknown[]): Promise<void> }
    const start = value.startSessionInternal.bind({ startsInFlight: new Map(), supervisor: {} })
    const held = await prepareSessionVersionHandoff({ target: 'fixture' }, async () => ({ busy: false }))
    try {
      let result!: Promise<void>
      expect(() => { result = start({ id: 'fixture' }) }).not.toThrow()
      await expect(result).rejects.toThrow('switching versions')
    } finally { await prepareSessionVersionHandoff({ target: 'fixture', release: held.result.token }, async () => ({ busy: false })) }
  })

  it('does not publish the real main heartbeat before the same backend boot resolves, or after it rejects', async () => {
    const main = ts.createSourceFile('main.ts', fs.readFileSync(path.join(root, 'apps/desktop/electron/main.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
    let block!: ts.Node
    const visit = (node: ts.Node) => {
      if (ts.isIfStatement(node) && node.expression.getText(main) === 'SERVER_MODE' && node.thenStatement.getText(main).includes('startServerAccountActivity')) block = node.thenStatement
      ts.forEachChild(node, visit)
    }
    visit(main)
    const boot = Promise.withResolvers<void>()
    const publish = vi.fn()
    const execute = (sessionHostBoot: Promise<void>) => runInNewContext(compile(`(async function () ${block.getText(main)})()`), {
      process, sessionHostBoot, app: { getPath: () => '/fixture' }, serverAuth: null,
      createLogger: () => ({ info: () => {} }), startServerAccountActivity: publish,
    }) as Promise<void>
    const running = execute(boot.promise)
    await Promise.resolve()
    expect(publish).not.toHaveBeenCalled()
    boot.resolve()
    await running
    expect(publish).toHaveBeenCalledOnce()
    publish.mockClear()
    await expect(execute(Promise.reject(new Error('late backend fatal')))).rejects.toThrow('late backend fatal')
    expect(publish).not.toHaveBeenCalled()
  })

  it('reopens admission when a supervisor loses its handoff reply, using monotonic expiry', async () => {
    let elapsed = 0
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    const target = '0.2.58-beta.101.1'
    const reply = await prepareSessionVersionHandoff({ target }, async () => ({ busy: false }))
    try {
      await expect(withSessionStartAdmission(async () => true)).rejects.toThrow('switching versions')
      elapsed = 60_001
      await expect(withSessionStartAdmission(async () => true)).resolves.toBe(true)
    } finally { await prepareSessionVersionHandoff({ target, release: reply.result.token }, async () => ({ busy: false })) }
  })

  it.runIf(process.platform !== 'win32')('bounds shutdown of its recorded unready child even when that process ignores SIGTERM', async () => {
    const source = ts.createSourceFile('supervisor.ts', fs.readFileSync(path.join(root, 'apps/desktop/electron/server/server-supervisor.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
    let restart!: ts.Node
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'createAccountVersionConverger') {
        const options = node.arguments[0] as ts.ObjectLiteralExpression
        restart = (options.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'restart') as ts.PropertyAssignment).initializer
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    const ready = Promise.withResolvers<void>()
    const owned = spawnOwnedChild(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], {
      stdio: ['ignore', 'pipe', 'ignore'], onError: error => ready.reject(error),
    })
    owned.child.stdout!.once('data', () => ready.resolve())
    try {
      await ready.promise
      const children = new Map([['fixture', { process: owned.child }]])
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const stop = runInNewContext(compile(`(${restart.getText(source)})`), {
        children, noteExitReason: () => {}, accountDataDir: () => '', CHILD_STOP_GRACE_MS: 30_000, setTimeout,
      }) as (id: string) => void
      const exited = new Promise(resolve => owned.child.once('exit', resolve))
      stop('fixture')
      expect(() => process.kill(owned.child.pid!, 0)).not.toThrow()
      await vi.advanceTimersByTimeAsync(30_000)
      await exited
      expect(owned.child.signalCode).toBe('SIGKILL')
    } finally { vi.useRealTimers(); await owned.stop() }
  })
})
