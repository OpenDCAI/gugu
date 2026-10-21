import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  INSPECT_BEGIN,
  INSPECT_END,
  UNINSTALLED_MARK,
  UninstallRun,
  inspectScript,
  parseInspectOutput,
  runSshUninstall,
  toInspection,
  uninstallScript,
} from '../../../../apps/desktop/electron/server/ssh-uninstall'
import { createSshMachineStore, registerSshMachinesIpc } from '../../../../apps/desktop/electron/server/ssh-machines'
import { createServerUpdateStateWriter } from '../../../../apps/desktop/electron/server/server-updater'
import type { SpawnSsh } from '../../../../apps/desktop/electron/server/ssh-install/runner'
import { SERVER_SSH_MACHINES_CHANNELS, type ServerUninstallState } from '../../../../apps/desktop/src/lib/serverSshMachines'

const ME = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-uninstall-6264-'))
}

/** 在本机 sh 上照真实布局造一台「装过咕咕 server」的家目录,跑同一份远端脚本。 */
function fakeInstall(home: string): string {
  const serverHome = path.join(home, '.gugu-server')
  const version = path.join(serverHome, 'versions', '0.2.99')
  fs.mkdirSync(path.join(version, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(version, 'version'), '0.2.99\n')
  fs.symlinkSync('versions/0.2.99', path.join(serverHome, 'current'))
  for (const [id, email, signedIn] of [[ME, 'me@example.test', true], [OTHER, 'lab@example.test', false]] as const) {
    fs.mkdirSync(path.join(serverHome, 'accounts', id, 'data'), { recursive: true })
    fs.writeFileSync(path.join(serverHome, 'accounts', id, 'account.json'), `${JSON.stringify({ userId: id, email, addedAt: 'x' }, null, 2)}\n`)
    if (signedIn) fs.writeFileSync(path.join(serverHome, 'accounts', id, 'data', 'server-session.enc'), 'x')
  }
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true })
  fs.symlinkSync(path.join(serverHome, 'current', 'bin', 'gugu-server'), path.join(home, '.local', 'bin', 'gugu-server'))
  fs.symlinkSync('/usr/bin/true', path.join(home, '.local', 'bin', 'node'))
  fs.mkdirSync(path.join(home, 'projects', 'app'), { recursive: true })
  return serverHome
}

/** 远端是 `sh -s` 读标准输入;这里把同一段脚本落成文件交给 sh(同步 spawn 不走 input,见 #3766)。 */
const runSh = (home: string, script: string): string => {
  const file = path.join(home, '.script.sh')
  fs.writeFileSync(file, script)
  try {
    return execFileSync('sh', [file], { env: { ...process.env, HOME: home, GUGU_SERVER_HOME: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } finally {
    fs.rmSync(file, { force: true })
  }
}

describe('#6264 从这台机器上卸载咕咕 server:远端脚本', () => {
  it('看一眼:报出版本与每个账号(有没有登录态、邮箱)', () => {
    const home = tmp()
    try {
      fakeInstall(home)
      const parsed = parseInspectOutput(`motd noise\n${runSh(home, inspectScript())}`)
      expect(parsed?.installed).toBe(true)
      expect(parsed?.version).toBe('0.2.99')
      expect(parsed?.accounts).toEqual(expect.arrayContaining([
        { userId: ME, signedIn: true, email: 'me@example.test' },
        { userId: OTHER, signedIn: false, email: 'lab@example.test' },
      ]))
      expect(toInspection(parsed!, ME).accounts[0]).toEqual({ email: 'me@example.test', signedIn: true, you: true })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('卸载:删掉安装目录与指进去的软链,别处的程序与项目文件夹不碰', () => {
    const home = tmp()
    try {
      const serverHome = fakeInstall(home)
      const out = runSh(home, uninstallScript())
      expect(out).toContain(UNINSTALLED_MARK)
      expect(fs.existsSync(serverHome)).toBe(false)
      expect(fs.existsSync(path.join(home, '.local', 'bin', 'gugu-server'))).toBe(false)
      // ~/.local/bin/node 指向别处 ⇒ 不是我们装的,留着
      expect(fs.lstatSync(path.join(home, '.local', 'bin', 'node')).isSymbolicLink()).toBe(true)
      expect(fs.existsSync(path.join(home, 'projects', 'app'))).toBe(true)
      // 再看一眼:什么都没有了
      expect(parseInspectOutput(runSh(home, inspectScript()))).toEqual({ installed: false, version: null, accounts: [] })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('#6264 卸载时把同机别的账号都注销(照 code tunnel unregister)', () => {
  it('每个还登着的账号各调一次 unregister,桌面自己那个留给桌面;都做完才删目录', () => {
    const home = tmp()
    try {
      const serverHome = fakeInstall(home)
      fs.writeFileSync(path.join(serverHome, 'accounts', OTHER, 'data', 'server-session.enc'), 'x')
      const log = path.join(home, 'calls.log')
      const bin = path.join(serverHome, 'versions', '0.2.99', 'bin', 'gugu-server')
      fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${log}'\n`, { mode: 0o755 })
      const out = runSh(home, uninstallScript({ keepUserId: ME }))
      expect(out).toContain(UNINSTALLED_MARK)
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
      expect(calls[0]).toBe(`unregister --account ${OTHER}`)
      expect(calls.join('\n')).not.toContain(`unregister --account ${ME}`)
      expect(calls).toContain('service uninstall')
      expect(fs.existsSync(serverHome)).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('账号 id 形状不对就不当成要留的那个(❌ 拼进脚本)', () => {
    expect(uninstallScript({ keepUserId: "x'; echo pwned #" })).toContain("KEEP=''")
  })
})

describe('#6264 卸载的状态机', () => {
  const target = { destination: 'alice@box', display: 'alice@box' }
  const inspectOut = `${INSPECT_BEGIN}\ninstalled=1\nversion=0.2.99\naccount=${ME} 1 me@example.test\naccount=${OTHER} 1 lab@example.test\n${INSPECT_END}\n`

  function harness(responses: Array<{ code: number; stdout?: string; stderr?: string }>, confirm: boolean) {
    const scripts: string[] = []
    const spawnSsh: SpawnSsh = async (_args, { stdin }) => {
      scripts.push(typeof stdin === 'string' ? stdin : stdin.file)
      const next = responses.shift() ?? { code: 0 }
      return { code: next.code, stdout: next.stdout ?? '', stderr: next.stderr ?? '' }
    }
    const states: ServerUninstallState[] = []
    const run = new UninstallRun('run-1', 'dev-1', 'alice@box', (s) => states.push(s))
    const done = runSshUninstall(target, run, {
      spawnSsh,
      controlPath: null,
      currentUserId: ME,
      waitForConfirm: async () => confirm,
      signal: new AbortController().signal,
    })
    return { done, scripts, states }
  }

  it('看过清单、确认之后才跑删除脚本;删完是 done', async () => {
    const { done, scripts, states } = harness([{ code: 0, stdout: inspectOut }, { code: 0, stdout: `${UNINSTALLED_MARK}\n` }], true)
    const final = await done
    expect(final.phase).toBe('done')
    expect(scripts).toHaveLength(2)
    const confirmState = states.find((s) => s.phase === 'confirm')
    expect(confirmState?.inspection?.accounts.map((a) => [a.email, a.you])).toEqual([['me@example.test', true], ['lab@example.test', false]])
  })

  it('人不确认 ⇒ 什么都不删,结束在 cancelled', async () => {
    const { done, scripts } = harness([{ code: 0, stdout: inspectOut }], false)
    expect((await done).phase).toBe('cancelled')
    expect(scripts).toHaveLength(1)
  })

  it('SSH 连不上 ⇒ failed,原因按 ssh 的报错归类;删不掉 ⇒ uninstallFailed', async () => {
    const refused = harness([{ code: 255, stderr: 'ssh: connect to host box port 22: Connection refused' }], true)
    expect((await refused.done).failure?.reason).toBe('connectionRefused')
    const stuck = harness([{ code: 0, stdout: inspectOut }, { code: 1, stderr: '卸载失败:删不掉 /home/alice/.gugu-server' }], true)
    const final = await stuck.done
    expect(final.phase).toBe('failed')
    expect(final.failure).toEqual({ reason: 'uninstallFailed', detail: '卸载失败:删不掉 /home/alice/.gugu-server' })
  })
})

describe('#6264 SSH 映射可以忘掉一台', () => {
  it('forget 删掉那一条并通知;没有这条返回 false', () => {
    const dir = tmp()
    try {
      const store = createSshMachineStore(path.join(dir, 'ssh-machines.json'))
      let changes = 0
      store.onChange(() => { changes += 1 })
      store.remember({ deviceId: 'dev-1', ownerUserId: ME, destination: 'alice@box', display: 'alice@box', addedAt: 'x' })
      expect(store.forget('dev-1')).toBe(true)
      expect(store.forget('dev-1')).toBe(false)
      expect(createSshMachineStore(path.join(dir, 'ssh-machines.json')).list()).toEqual([])
      expect(changes).toBe(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('#6264 渲染层的「忘掉这台」只认此刻登着的这个人装上的机器', () => {
  function forgetVia(userId: string | null) {
    const dir = tmp()
    const store = createSshMachineStore(path.join(dir, 'ssh-machines.json'))
    store.remember({ deviceId: 'mine', ownerUserId: ME, destination: 'me@box', display: 'me@box', addedAt: 'x' })
    store.remember({ deviceId: 'theirs', ownerUserId: OTHER, destination: 'lab@box', display: 'lab@box', addedAt: 'x' })
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const ipcMain = { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, fn) } }
    registerSshMachinesIpc({ ipcMain: ipcMain as never, getWindow: () => null, store, currentUserId: async () => userId })
    const forget = (deviceId: string) => Promise.resolve(handlers.get(SERVER_SSH_MACHINES_CHANNELS.forget)!({}, deviceId))
    const left = () => store.list().map((m) => m.deviceId).sort()
    return { forget, left, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
  }

  it('别人装的那台(换号前那个人的)删不掉,自己的照删', async () => {
    const { forget, left, cleanup } = forgetVia(ME)
    try {
      await expect(forget('theirs')).resolves.toBe(false)
      expect(left()).toEqual(['mine', 'theirs'])
      await expect(forget('mine')).resolves.toBe(true)
      expect(left()).toEqual(['theirs'])
    } finally {
      cleanup()
    }
  })

  it('没登录 ⇒ 谁的都不删', async () => {
    const { forget, left, cleanup } = forgetVia(null)
    try {
      await expect(forget('mine')).resolves.toBe(false)
      await expect(forget('theirs')).resolves.toBe(false)
      expect(left()).toEqual(['mine', 'theirs'])
    } finally {
      cleanup()
    }
  })
})

describe('#6264 server 升级状态写给账号进程看', () => {
  it('写到 data/server-update.json,clear 删掉', () => {
    const dir = tmp()
    try {
      const writer = createServerUpdateStateWriter(dir, () => 42)
      writer.set('ready', '0.3.0')
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'server-update.json'), 'utf8'))).toEqual({ state: 'ready', version: '0.3.0', at: 42 })
      writer.clear()
      expect(fs.existsSync(path.join(dir, 'data', 'server-update.json'))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
