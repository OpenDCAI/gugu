import { fork, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultEngineTreeOps } from '../../../../packages/session-core/src/acp/engine-tree'

const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0

describe.runIf(process.platform !== 'win32')('real host exit with a detached ACP adapter', () => {
  let dir: string
  let hostEntry: string
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-host-exit-tree-'))
    const workerEntry = path.join(dir, 'worker.cjs')
    const adapterEntry = path.join(dir, 'adapter.cjs')
    const bootEntry = path.join(dir, 'boot-check.cjs')
    const miseEntry = path.join(dir, 'mise.cjs')
    hostEntry = path.join(dir, 'host.cjs')
    fs.writeFileSync(bootEntry, `#!${process.execPath}
      const {spawn}=require('node:child_process');
      const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      const probe=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
      require('node:fs').writeFileSync(process.env.BOOT_TREE_FILE,JSON.stringify({boot:process.pid,bootWorker:worker.pid,probe:probe.pid}));
      setInterval(()=>{},1000);
    `, { mode: 0o700 })
    fs.writeFileSync(adapterEntry, `
      const {spawn}=require('node:child_process');
      const engine=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      require('node:fs').writeFileSync(process.env.TREE_FILE,JSON.stringify({worker:process.ppid,adapter:process.pid,engine:engine.pid}));
      setInterval(()=>{},1000);
    `)
    fs.writeFileSync(miseEntry, `
      const {spawn}=require('node:child_process');
      const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      require('node:fs').writeFileSync(process.env.MISE_TREE_FILE,JSON.stringify({mise:process.pid,miseWorker:worker.pid}));
      setInterval(()=>{},1000);
    `)
    fs.writeFileSync(workerEntry, `
      if(process.env.TMUX_SOCKET){
        const {execFileSync}=require('node:child_process'),socket=process.env.TMUX_SOCKET;
        execFileSync('tmux',['-S',socket,'new-session','-d','-s','fixture','exec /bin/sleep 3600'],{env:{...process.env,TMUX:''}});
        const [server,pane]=execFileSync('tmux',['-S',socket,'display-message','-p','-t','fixture','#{pid} #{pane_pid}'],{encoding:'utf8'}).trim().split(' ').map(Number);
        require('node:fs').writeFileSync(process.env.TMUX_TREE_FILE,JSON.stringify({server,pane}));
      }
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
      import * as engineTree from ${JSON.stringify(path.resolve('packages/session-core/src/acp/engine-tree.ts'))};
      const {signalProcessDescendantsSync}=engineTree;
      import {killServerDescendantsSync} from ${JSON.stringify(path.resolve('apps/desktop/electron/server/server-processes.ts'))};
      import {checkAccountBoot} from ${JSON.stringify(path.resolve('apps/desktop/electron/server/server-selftest.ts'))};
      import {runMiseProcess} from ${JSON.stringify(path.resolve('apps/desktop/electron/session/main/core/dependencies/mise-process.ts'))};
      const logDir=${JSON.stringify(dir)},shutdownLogger={info(){},error(){},warn(){}};
      const createLogger=()=>shutdownLogger,classifyFatal=()=>'defect',recordFatalSync=()=>{};
      const killAllCodexAppServerProcessGroupsSync=()=>{},opencodeServeAttachSessionDelivery={disposeSync(){}},droidDaemonSessionDelivery={disposeSync(){}};
      const emdashBridge=null,closeTunnelMachines=null,tunnelEndpoint=null;
      const app={getPath:()=>''},noteExitReason=()=>{},stopServerActivity=()=>{},deviceRuntimeHost=null,SERVER_MODE=process.env.EXIT_SCOPE!=='desktop',EXIT_RESTART=75,isSingleServerRun=()=>false;
      let signalStopping=false;
      ${declaration('killEnginesOnCrash')}
      ${declaration('exitOnSignal')}
      ${fatal}
      void(async()=>{
        const {logger}=createStubLogger();
        await spawnWorker({name:'fixture',entry:${JSON.stringify(workerEntry)},contract:defineContract({}),scope:createScope({logger}),supervision:{restart:'never'}});
        void checkAccountBoot(${JSON.stringify(bootEntry)}).catch(()=>{});
        void runMiseProcess(process.execPath,[${JSON.stringify(miseEntry)}],{cwd:logDir,env:process.env}).catch(()=>{});
        while(!existsSync(process.env.TREE_FILE)) await new Promise(resolve=>setTimeout(resolve,5));
        while(!existsSync(process.env.BOOT_TREE_FILE)) await new Promise(resolve=>setTimeout(resolve,5));
        while(!existsSync(process.env.MISE_TREE_FILE)) await new Promise(resolve=>setTimeout(resolve,5));
        process.on('message',kind=>{
          if(kind==='crash') setImmediate(()=>{throw new Error('download parser failure fixture')});
          else exitOnSignal('SIGTERM',kind==='stop'?143:75);
        });
        process.send('ready');
      })();
    ` }, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3', 'node-pty', '@parcel/watcher'], outfile: hostEntry })
  })
  afterAll(() => {
    if (!dir.startsWith(path.join(os.tmpdir(), 'gugu-host-exit-tree-'))) throw new Error('Unexpected fixture directory')
    fs.rmSync(dir, { recursive: true, force: true })
  })
  async function exitHost(kind: string, code: number, withTmux = false, server = true) {
    const record = path.join(dir, `${kind}.json`)
    const bootRecord = path.join(dir, `${kind}-boot.json`)
    const miseRecord = path.join(dir, `${kind}-mise.json`)
    const tmuxRecord = path.join(dir, `${kind}-tmux.json`)
    const tmuxSocket = path.join(dir, `${kind}.sock`)
    for (const file of [record, bootRecord, miseRecord, tmuxRecord]) fs.rmSync(file, { force: true })
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
    const host = fork(hostEntry, [], { silent: true, env: { ...process.env, TREE_FILE: record, BOOT_TREE_FILE: bootRecord, MISE_TREE_FILE: miseRecord,
      TMUX_TREE_FILE: tmuxRecord, TMUX_SOCKET: withTmux ? tmuxSocket : '', EXIT_SCOPE: server ? 'server' : 'desktop' } })
    let tree: { worker: number; adapter: number; engine: number } | undefined
    let boot: { boot: number; bootWorker: number; probe: number } | undefined
    let mise: { mise: number; miseWorker: number } | undefined
    let tmux: { server: number; pane: number } | undefined
    try {
      await once(host, 'message', { signal: AbortSignal.timeout(10_000) })
      tree = JSON.parse(fs.readFileSync(record, 'utf8')) as typeof tree
      boot = JSON.parse(fs.readFileSync(bootRecord, 'utf8')) as typeof boot
      mise = JSON.parse(fs.readFileSync(miseRecord, 'utf8')) as typeof mise
      if (withTmux) tmux = JSON.parse(fs.readFileSync(tmuxRecord, 'utf8')) as typeof tmux
      console.info('Host exit fixture recorded processes:', { ...tree, ...boot, ...mise, tmux })
      const before = defaultEngineTreeOps().snapshotSync()
      expect(before.find(row => row.pid === tree!.adapter)?.pgid).toBe(tree!.adapter)
      expect(before.find(row => row.pid === tree!.engine)?.pgid).toBe(tree!.adapter)
      expect(before.find(row => row.pid === boot!.boot)?.pgid).toBe(boot!.boot)
      expect(before.find(row => row.pid === boot!.probe)?.pgid).toBe(boot!.probe)
      expect(before.find(row => row.pid === mise!.mise)?.pgid).toBe(mise!.mise)
      if (tmux) expect(before.find(row => row.pid === tmux!.server)?.ppid).toBe(1)
      const closed = once(host, 'close')
      host.send(kind)
      expect(await closed).toEqual([code, null])
      await vi.waitFor(() => {
        const live = defaultEngineTreeOps().snapshotSync()
        for (const pid of Object.values(tree!)) expect(live.some(row => row.pid === pid)).toBe(false)
        for (const pid of Object.values({ ...boot, ...mise })) expect(live.some(row => row.pid === pid)).toBe(!server)
      })
      expect(defaultEngineTreeOps().snapshotSync().some(row => row.pid === unrelated.pid)).toBe(true)
      if (tmux) {
        const live = defaultEngineTreeOps().snapshotSync()
        for (const pid of Object.values(tmux)) expect(live.some(row => row.pid === pid)).toBe(true)
      }
    } finally {
      for (const child of [host, unrelated] as ChildProcess[]) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'close'); child.kill('SIGKILL'); await exited
        }
      }
      for (const pid of Object.values({ ...tree, ...boot, ...mise, ...tmux })) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already reaped */ }
      }
    }
  }
  it.each([['crash', 1], ['update', 75], ['stop', 143]] as const)('reaps the adapter and an in-progress boot check before the actual %s exit', exitHost)
  it.runIf(tmuxAvailable).each([['crash', 1], ['update', 75]] as const)('preserves an actual double-forked tmux and its command across %s', async (kind, code) => exitHost(kind, code, true))
  it('keeps desktop-owned external programs outside the worker cleanup scope', async () => exitHost('crash', 1, false, false))
})
