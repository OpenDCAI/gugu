import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkAccountBoot } from '../../../../apps/desktop/electron/server/server-selftest'
import { collectLocalProcessSnapshotSync } from '../../../../packages/session-core/src/pty/process-tree'

const directories = new Set<string>()
const probePids = new Set<number>()
const records: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const record of records.splice(0)) {
    if (!fs.existsSync(record)) continue
    const row = JSON.parse(fs.readFileSync(record, 'utf8')) as { home: string; probePid?: number }
    directories.add(row.home)
    if (row.probePid) probePids.add(row.probePid)
  }
  for (const pid of probePids) {
    try { process.kill(pid, 'SIGKILL') } catch { /* The production cleanup already stopped it. */ }
  }
  probePids.clear()
  for (const directory of directories) {
    console.info('Account boot fixture cleanup:', directory)
    expect(path.dirname(directory)).toBe(os.tmpdir())
    expect(path.basename(directory)).toMatch(/^gugu-(selftest-cleanup|boot)-/)
    fs.rmSync(directory, { recursive: true, force: true })
  }
  directories.clear()
})

function fixture({ probe = false, failure = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-selftest-cleanup-'))
  directories.add(directory)
  const binary = path.join(directory, 'gugu-server')
  const record = path.join(directory, 'started.json')
  records.push(record)
  const probeCode = `process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)`
  fs.writeFileSync(binary, `#!${process.execPath}
    const fs=require('node:fs'),path=require('node:path');
    process.on('SIGTERM',()=>process.exit(143));
    const home=process.env.GUGU_SERVER_HOME;
    const ready=(probePid)=>{
      fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,home,probePid}));
      if(${failure}) process.exit(1);
      const data=process.env.GUGU_TASK_HOST_USER_DATA;
      const file=path.join(data,'activity.json');
      fs.writeFileSync(file+'.tmp',JSON.stringify({pid:process.pid,startedAt:Date.now(),at:Date.now(),busy:false,runtimeOwned:true}));
      fs.renameSync(file+'.tmp',file);
      setInterval(()=>{},1000);
    };
    if(${probe}) {
      const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(probeCode)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
      child.once('message',()=>ready(child.pid));
    } else ready();
  `, { mode: 0o700 })
  const reading = () => {
    const row = JSON.parse(fs.readFileSync(record, 'utf8')) as { pid: number; home: string; probePid?: number }
    console.info('Account boot fixture processes:', row)
    directories.add(row.home)
    if (row.probePid) probePids.add(row.probePid)
    return row
  }
  return { binary, reading }
}

describe.runIf(process.platform !== 'win32')('account boot cleanup', () => {
  it('observes a real heartbeat without depending on filesystem event delivery', async () => {
    const { binary, reading } = fixture()
    const watch = vi.spyOn(fs, 'watch').mockImplementation(() => { throw new Error('filesystem events are delayed') })
    await expect(checkAccountBoot(binary)).resolves.toBeUndefined()
    expect(watch).not.toHaveBeenCalled()
    expect(fs.existsSync(reading().home)).toBe(false)
  })

  it('stops a detached probe while its parent chain still exists, then removes its temporary home', async () => {
    const { binary, reading } = fixture({ probe: true })
    try {
      await checkAccountBoot(binary)
    } finally {
      const row = reading()
      await vi.waitFor(() => expect(collectLocalProcessSnapshotSync().some(member => member.pid === row.probePid)).toBe(false))
      expect(fs.existsSync(row.home)).toBe(false)
    }
  })

  it.each([false, true])('warns about failed directory cleanup without replacing the boot result (boot failure=%s)', async failure => {
    const { binary, reading } = fixture({ failure })
    const remove = fs.rmSync.bind(fs)
    const cleanupError = Object.assign(new Error('scratch directory is still being written'), { code: 'ENOTEMPTY' })
    vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      if (path.basename(String(file)).startsWith('gugu-boot-')) throw cleanupError
      remove(file, options)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    if (failure) await expect(checkAccountBoot(binary)).rejects.toThrow('Account boot exited before serving (1)')
    else await expect(checkAccountBoot(binary)).resolves.toBeUndefined()
    const row = reading()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(row.home), cleanupError)
    expect(fs.existsSync(row.home)).toBe(true)
  })
})
