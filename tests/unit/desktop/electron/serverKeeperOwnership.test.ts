import { fork } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { awaitExit, awaitFact } from '../../../support/awaitFact'
import { defaultEngineTreeOps, signalProcessDescendantsSync } from '../../../../packages/session-core/src/acp/engine-tree'
import { isProcessAlive } from '../../../../apps/desktop/electron/server/process-alive'

it.runIf(process.platform !== 'win32').each([75, 1])('a manually adopted keeper survives host cleanup and restarts after exit %s', async code => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-keeper-owner-'))
  const record = path.join(home, 'keeper.json'), restarted = path.join(home, 'restarted')
  const released = path.join(home, 'host-exited'), testBin = path.join(home, 'test-bin')
  fs.mkdirSync(testBin)
  // The ownership contract waits for the real host exit, not the production ten-second polling cadence.
  fs.writeFileSync(path.join(testBin, 'sleep'), '#!/bin/sh\nif [ "$1" != 10 ]; then exec /bin/sleep "$@"; fi\nwhile [ ! -f "$GUGU_TEST_KEEPER_RELEASE" ]; do /bin/sleep 0.01; done\n', { mode: 0o700 })
  const bin = path.join(home, 'current/bin/gugu-server'), entry = path.join(home, 'host.cjs')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, `#!/bin/sh\necho restarted > '${restarted}'\nexit 78\n`, { mode: 0o700 })
  await build({ stdin: { loader: 'ts', resolveDir: process.cwd(), contents: `
    import fs from 'node:fs';
    import {startKeeper,keeperPidFile} from ${JSON.stringify(path.resolve('apps/desktop/electron/server/server-keeper.ts'))};
    import {killServerDescendantsSync} from ${JSON.stringify(path.resolve('apps/desktop/electron/server/server-processes.ts'))};
    const home=${JSON.stringify(home)};
    startKeeper({home,logFile:home+'/service.log',adoptPid:process.pid});
    process.on('message',()=>{killServerDescendantsSync();process.exit(${code})});
    const timer=setInterval(()=>{if(fs.existsSync(keeperPidFile(home))){
      clearInterval(timer);fs.writeFileSync(${JSON.stringify(record)},fs.readFileSync(keeperPidFile(home)));}},10);
  ` }, outfile: entry, bundle: true, platform: 'node', format: 'cjs' })
  const host = fork(entry, [], { silent: true, env: {
    ...process.env, PATH: testBin + path.delimiter + process.env.PATH, GUGU_TEST_KEEPER_RELEASE: released,
    GUGU_HOME: path.join(home, 'home'), GUGU_USER_DATA_DIR: path.join(home, 'user-data'),
  } })
  let keeper: number | undefined
  try {
    keeper = await awaitFact('keeper publishes its actual pid', () => fs.existsSync(record) ? Number(fs.readFileSync(record, 'utf8')) : undefined, { producer: host })
    const row = defaultEngineTreeOps().snapshotSync().find(p => p.pid === keeper)
    console.info('Manual host and keeper:', { host: host.pid, keeper, ppid: row?.ppid, pgid: row?.pgid })
    expect(row?.ppid).not.toBe(host.pid)
    expect(row?.pgid).toBe(keeper)
    const exited = awaitExit('manual host exits after descendant cleanup', host)
    host.send('exit')
    expect(await exited).toEqual({ code, signal: null })
    fs.writeFileSync(released, 'host exit observed')
    await awaitFact('keeper starts the selected package after its adopted host exits', () => {
      if (fs.existsSync(restarted)) return true
      if (!isProcessAlive(keeper!)) throw new Error('Keeper exited before restarting the server')
      return undefined
    })
  } finally {
    for (const pid of [host.pid, keeper]) if (pid) {
      signalProcessDescendantsSync([pid], 'SIGKILL')
      try { process.kill(pid, 'SIGKILL') } catch { /* already stopped */ }
    }
    console.info('Keeper ownership fixture cleanup:', home)
    expect(home.startsWith(path.join(os.tmpdir(), 'gugu-keeper-owner-'))).toBe(true)
    fs.rmSync(home, { recursive: true, force: true })
  }
})
