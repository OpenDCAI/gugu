import { fork } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'
import { defaultEngineTreeOps } from '../../../../packages/session-core/src/acp/engine-tree'

describe.runIf(process.platform !== 'win32')('waiting-for-login server owns staging subprocesses', () => {
  it.each([['SIGTERM', 143], ['SIGUSR2', 75], ['crash', 1]] as const)('reaps a running boot check on %s before loading main', async (signal, code) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-waiting-exit-'))
    const record = path.join(home, 'boot-tree.json')
    const binary = path.join(home, 'boot-check')
    const entry = path.join(home, 'host.cjs')
    fs.writeFileSync(binary, `#!${process.execPath}
      const {spawn}=require('node:child_process');
      const a=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      const b=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
      require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({boot:process.pid,worker:a.pid,probe:b.pid}));
      setInterval(()=>{},1000);
    `, { mode: 0o700 })
    const root = path.resolve('apps/desktop/electron/server')
    await build({ stdin: { loader: 'ts', resolveDir: process.cwd(), contents: `
      import {existsSync} from 'node:fs';
      import {runSingleServer} from ${JSON.stringify(path.join(root, 'server-run.ts'))};
      import {acquireHomeLock} from ${JSON.stringify(path.join(root, 'server-startup.ts'))};
      acquireHomeLock(process.env.GUGU_SERVER_HOME);
      void runSingleServer(()=>{},async()=>{throw new Error('Account body must not load')});
      process.on('message',()=>setImmediate(()=>{throw new Error('waiting host crash fixture')}));
      const ready=setInterval(()=>{if(existsSync(${JSON.stringify(record)})){clearInterval(ready);process.send('ready')}},5);
    ` }, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3', 'node-pty', '@parcel/watcher'], outfile: entry,
      plugins: [{ name: 'unrelated-service-boundaries', setup(context) {
        context.onResolve({ filter: /^\.\/server-(updater|service|health)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
        context.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === './server-updater'
          ? `import {checkAccountBoot} from ${JSON.stringify(path.join(root, 'server-selftest.ts'))};
              export const managedLayout=()=>null;
              export const startServerUpdater=()=>{void checkAccountBoot(${JSON.stringify(binary)}).catch(()=>{});return{dispose(){}}};`
          : args.path === './server-service'
            ? 'export const repairServiceDefinition=()=>{};'
            : 'export const SUPERVISOR_HEALTH_MS=30000;export const writeSupervisorHealth=()=>{};', loader: 'ts', resolveDir: process.cwd() }))
      } }],
    })
    const host = fork(entry, [], { silent: true, env: { ...process.env, GUGU_SERVER_HOME: home, GUGU_SERVER_SUPERVISED: 'systemd' } })
    let tree: Record<string, number> = {}
    try {
      await once(host, 'message', { signal: AbortSignal.timeout(10_000) })
      tree = JSON.parse(fs.readFileSync(record, 'utf8'))
      console.info('Waiting server boot-check tree:', tree)
      const closed = once(host, 'close')
      if (signal === 'crash') host.send('crash')
      else host.kill(signal)
      expect(await closed).toEqual([code, null])
      await vi.waitFor(() => {
        const table = defaultEngineTreeOps().snapshotSync()
        expect(Object.entries(tree).filter(([, pid]) => table.some(row => row.pid === pid))).toEqual([])
      })
    } finally {
      if (host.exitCode === null && host.signalCode === null) {
        const closed = once(host, 'close'); host.kill('SIGKILL'); await closed
      }
      for (const pid of Object.values(tree)) try { process.kill(pid, 'SIGKILL') } catch { /* already stopped */ }
      console.info('Waiting server fixture cleanup:', home)
      expect(home.startsWith(path.join(os.tmpdir(), 'gugu-waiting-exit-'))).toBe(true)
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
