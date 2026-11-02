import { fork, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultEngineTreeOps } from '../../../../packages/session-core/src/acp/engine-tree'

describe.runIf(process.platform !== 'win32')('real host exit with a detached ACP adapter', () => {
  let dir: string
  let hostEntry: string
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-host-exit-tree-'))
    const workerEntry = path.join(dir, 'worker.cjs')
    const adapterEntry = path.join(dir, 'adapter.cjs')
    hostEntry = path.join(dir, 'host.cjs')
    fs.writeFileSync(adapterEntry, `
      const {spawn}=require('node:child_process');
      const engine=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      require('node:fs').writeFileSync(process.env.TREE_FILE,JSON.stringify({worker:process.ppid,adapter:process.pid,engine:engine.pid}));
      setInterval(()=>{},1000);
    `)
    fs.writeFileSync(workerEntry, `
      require('node:child_process').spawn(process.execPath,[${JSON.stringify(adapterEntry)}],{detached:true,stdio:'ignore'});
      process.send({kind:'wire-runtime-signal',event:'ready'});
      setInterval(()=>{},1000);
    `)
    const main = ts.createSourceFile('main.ts', fs.readFileSync(path.resolve(__dirname, '../../../../apps/desktop/electron/main.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
    const declaration = (name: string) => main.statements.find(node => ts.isVariableStatement(node)
      && node.declarationList.declarations.some(item => item.name.getText(main) === name))!.getText(main)
    const fatal = main.statements.find(node => node.getText(main).startsWith("process.on('uncaughtException'"))!.getText(main)
    await build({ stdin: { loader: 'ts', resolveDir: process.cwd(), contents: `
      import {appendFileSync,existsSync} from 'node:fs';
      import {join} from 'node:path';
      import {spawnWorker,killAllWorkersSync} from ${JSON.stringify(path.resolve('packages/session-wire/src/worker/index.ts'))};
      import {defineContract} from ${JSON.stringify(path.resolve('packages/session-wire/src/api/define.ts'))};
      import {createScope} from ${JSON.stringify(path.resolve('packages/session-wire/src/util/scope.ts'))};
      import {createStubLogger} from ${JSON.stringify(path.resolve('packages/session-wire/src/testing/index.ts'))};
      import {signalProcessDescendantsSync} from ${JSON.stringify(path.resolve('packages/session-core/src/acp/engine-tree.ts'))};
      const logDir=${JSON.stringify(dir)},shutdownLogger={info(){},error(){},warn(){}};
      const createLogger=()=>shutdownLogger,classifyFatal=()=>'defect',recordFatalSync=()=>{};
      const killAllCodexAppServerProcessGroupsSync=()=>{},opencodeServeAttachSessionDelivery={disposeSync(){}},droidDaemonSessionDelivery={disposeSync(){}};
      const emdashBridge=null,closeTunnelMachines=null,tunnelEndpoint=null;
      const app={getPath:()=>''},noteExitReason=()=>{},stopServerActivity=()=>{},deviceRuntimeHost=null,SERVER_MODE=true,EXIT_RESTART=75,isSingleServerRun=()=>false;
      let signalStopping=false;
      ${declaration('killEnginesOnCrash')}
      ${declaration('exitOnSignal')}
      ${fatal}
      void(async()=>{
        const {logger}=createStubLogger();
        await spawnWorker({name:'fixture',entry:${JSON.stringify(workerEntry)},contract:defineContract({}),scope:createScope({logger}),supervision:{restart:'never'}});
        while(!existsSync(process.env.TREE_FILE)) await new Promise(resolve=>setTimeout(resolve,5));
        process.on('message',kind=>{
          if(kind==='crash') setImmediate(()=>{throw new Error('download parser failure fixture')});
          else exitOnSignal('SIGTERM',75);
        });
        process.send('ready');
      })();
    ` }, bundle: true, platform: 'node', format: 'cjs', outfile: hostEntry })
  })
  afterAll(() => {
    if (!dir.startsWith(path.join(os.tmpdir(), 'gugu-host-exit-tree-'))) throw new Error('Unexpected fixture directory')
    fs.rmSync(dir, { recursive: true, force: true })
  })
  it.each([['crash', 1], ['update', 75]] as const)('reaps adapter and engine before the actual %s exit', async (kind, code) => {
    const record = path.join(dir, `${kind}.json`)
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
    const host = fork(hostEntry, [], { silent: true, env: { ...process.env, TREE_FILE: record } })
    let tree: { worker: number; adapter: number; engine: number } | undefined
    try {
      await once(host, 'message')
      tree = JSON.parse(fs.readFileSync(record, 'utf8')) as typeof tree
      const before = defaultEngineTreeOps().snapshotSync()
      expect(before.find(row => row.pid === tree!.adapter)?.pgid).toBe(tree!.adapter)
      expect(before.find(row => row.pid === tree!.engine)?.pgid).toBe(tree!.adapter)
      const closed = once(host, 'close')
      host.send(kind)
      expect(await closed).toEqual([code, null])
      await vi.waitFor(() => {
        const live = defaultEngineTreeOps().snapshotSync()
        for (const pid of Object.values(tree!)) expect(live.some(row => row.pid === pid)).toBe(false)
      })
      expect(defaultEngineTreeOps().snapshotSync().some(row => row.pid === unrelated.pid)).toBe(true)
    } finally {
      for (const child of [host, unrelated] as ChildProcess[]) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'close'); child.kill('SIGKILL'); await exited
        }
      }
      for (const pid of Object.values(tree ?? {})) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already reaped */ }
      }
    }
  })
})
