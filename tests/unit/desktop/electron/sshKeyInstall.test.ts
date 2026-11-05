// #6264「下次免密」(electron/server/ssh-key-install.ts + ssh-prompts 的勾选往返 + 机器记录关联钥匙)。
// 装钥匙的那段 sh 真在本机 sh 里跑(临时 HOME),判据对着 ssh-copy-id 的行为:建 .ssh 700 / 文件 600、
// 末尾补换行、同一把钥匙不追加第二次;写不进去如实报。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizedKeyLine,
  classifyVerifyFailure,
  ensureGuguKey,
  guguKeyComment,
  installAuthorizedKeyScript,
  installGuguKey,
  installKeySshArgs,
  parseInstallOutput,
  parsePublicKey,
  verifyKeySshArgs,
  withGuguIdentity,
} from '../../../../apps/desktop/electron/server/ssh-key-install'
import { createSshPromptBroker, createTerminalAskpass, type openAskpassWorkspace } from '../../../../apps/desktop/electron/server/ssh-prompts'
import type { AskpassHandler } from '../../../../apps/desktop/electron/server/ssh-askpass'
import { createMachineKeyInstaller, createDirectTerminalResolver, type SshMachine } from '../../../../apps/desktop/electron/server/ssh-machines'
import type { SpawnSsh } from '../../../../apps/desktop/electron/server/ssh-install/runner'
import type { SshPrompt } from '../../../../apps/desktop/src/session/shared/ssh-prompt'

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHf9mX0bq1xQ7f3dJ2c0wz0mZ6n2K1n0cZr9m9s1a2b3 whatever@laptop'
const BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIHf9mX0bq1xQ7f3dJ2c0wz0mZ6n2K1n0cZr9m9s1a2b3'
const unix = process.platform === 'win32' ? describe.skip : describe

const temps: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-key-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temps.splice(0)) {
    spawnSync('chmod', ['-R', 'u+w', dir])
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('钥匙那一行', () => {
  it('注释是 gugu@这台电脑,怪字符剥掉;.local 去掉', () => {
    expect(guguKeyComment('Yangs-MacBook-Pro.local')).toBe('gugu@Yangs-MacBook-Pro')
    expect(guguKeyComment("evil'; rm -rf ~")).toBe('gugu@evilrm-rf')
    expect(guguKeyComment('')).toBe('gugu@desktop')
  })

  it('只收认得的公钥形状;那一行 = 类型 本体 gugu@…(原注释换掉)', () => {
    expect(parsePublicKey(PUB)).toEqual({ type: 'ssh-ed25519', blob: BLOB })
    expect(parsePublicKey("ssh-ed25519 AAAA'x")).toBeNull()
    expect(parsePublicKey('command="x" ssh-ed25519 AAAA')).toBeNull()
    expect(authorizedKeyLine(PUB, 'gugu@mbp')).toBe(`ssh-ed25519 ${BLOB} gugu@mbp`)
    expect(() => authorizedKeyLine(PUB, 'gugu@a b')).toThrow()
  })

  it('关联到机器:加一个 -o IdentityFile=…,已经有了不重复加,别的选项原样留着', () => {
    expect(withGuguIdentity(undefined, '/d/ssh/id_ed25519')).toEqual(['-o', 'IdentityFile=/d/ssh/id_ed25519'])
    const once = withGuguIdentity(['-J', 'jump'], '/d/ssh/id_ed25519')
    expect(once).toEqual(['-J', 'jump', '-o', 'IdentityFile=/d/ssh/id_ed25519'])
    expect(withGuguIdentity(once, '/d/ssh/id_ed25519')).toEqual(once)
  })

  it('装:复用已认证的连接(ControlMaster=no),没有就单连;验:只用这把钥匙、不许问、不复用', () => {
    const target = { destination: 'alice@box', port: 2222, display: 'alice@box:2222', options: ['-J', 'jump'] }
    const install = installKeySshArgs(target, '/tmp/cm-%C')
    expect(install).toEqual(expect.arrayContaining(['ControlMaster=no', 'ControlPath=/tmp/cm-%C', '-J', 'jump']))
    expect(install.slice(-4)).toEqual(['--', 'alice@box', 'sh', '-s'])
    expect(installKeySshArgs(target, null)).toContain('ControlPath=none')
    const verify = verifyKeySshArgs(target, '/d/ssh/id_ed25519')
    for (const opt of ['BatchMode=yes', 'ControlPath=none', 'PreferredAuthentications=publickey', 'IdentitiesOnly=yes', 'IdentityFile=/d/ssh/id_ed25519']) {
      expect(verify).toContain(opt)
    }
    expect(verify.slice(-3)).toEqual(['--', 'alice@box', 'exit 0'])
  })

  it('验证没过:「Permission denied」= 对方不收钥匙;别的 = 没连上', () => {
    expect(classifyVerifyFailure('alice@box: Permission denied (password).')).toBe('not-accepted')
    expect(classifyVerifyFailure('ssh: connect to host box port 22: Connection refused')).toBe('unreachable')
  })
})

unix('装钥匙的那段 sh(真跑,临时家目录)', () => {
  const line = `ssh-ed25519 ${BLOB} gugu@mbp`
  const run = (home: string) => {
    const script = path.join(tempDir(), 'install.sh')
    fs.writeFileSync(script, installAuthorizedKeyScript(line))
    const fd = fs.openSync(script, 'r')
    const result = spawnSync('sh', ['-s'], { stdio: [fd, 'pipe', 'pipe'], env: { ...process.env, HOME: home }, encoding: 'utf8' })
    fs.closeSync(fd)
    return parseInstallOutput({ code: result.status, stdout: result.stdout })
  }
  const mode = (p: string) => (fs.statSync(p).mode & 0o777).toString(8)

  it('没有 .ssh:建出来 700、文件 600,正好一行;再跑一次不追加', () => {
    const home = tempDir()
    expect(run(home)).toBe('added')
    const file = path.join(home, '.ssh', 'authorized_keys')
    expect(fs.readFileSync(file, 'utf8')).toBe(`${line}\n`)
    expect(mode(path.join(home, '.ssh'))).toBe('700')
    expect(mode(file)).toBe('600')
    expect(run(home)).toBe('present')
    expect(fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes(BLOB))).toHaveLength(1)
  })

  it('原有文件末尾没换行:先补一个再追加,原有内容一字不动;组可写的位去掉', () => {
    const home = tempDir()
    fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o775 })
    fs.chmodSync(path.join(home, '.ssh'), 0o775)
    const file = path.join(home, '.ssh', 'authorized_keys')
    fs.writeFileSync(file, 'ssh-rsa AAAAB3Nza other@host', { mode: 0o664 })
    fs.chmodSync(file, 0o664)
    expect(run(home)).toBe('added')
    expect(fs.readFileSync(file, 'utf8')).toBe(`ssh-rsa AAAAB3Nza other@host\n${line}\n`)
    expect(mode(path.join(home, '.ssh'))).toBe('755')
    expect(mode(file)).toBe('644')
  })

  it('同一把钥匙已经在(别的注释)也不追加', () => {
    const home = tempDir()
    fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 })
    fs.writeFileSync(path.join(home, '.ssh', 'authorized_keys'), `ssh-ed25519 ${BLOB} someone-added-it\n`)
    expect(run(home)).toBe('present')
  })

  it.skipIf(process.getuid?.() === 0)('家目录写不进去:如实报 write-failed', () => {
    const home = tempDir()
    fs.chmodSync(home, 0o500)
    expect(run(home)).toBe('write-failed')
  })
})

unix('咕咕自己那把钥匙', () => {
  it('没有就用 ssh-keygen 生成(ed25519、无口令、注释 gugu@…),私钥只本用户可读;再要一次用同一把', async () => {
    if (spawnSync('ssh-keygen', ['-?']).error) return
    const dir = path.join(tempDir(), 'ssh')
    const first = await ensureGuguKey({ dir, comment: 'gugu@test' })
    expect(first.publicKey).toMatch(/^ssh-ed25519 \S+ gugu@test$/)
    expect((fs.statSync(first.keyPath).mode & 0o077)).toBe(0)
    const again = await ensureGuguKey({ dir, comment: 'gugu@test' })
    expect(again.publicKey).toBe(first.publicKey)
  })

  it('只剩半把(有公钥没私钥):❌ 覆盖,如实失败', async () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'id_ed25519.pub'), PUB)
    const keygen = vi.fn()
    await expect(ensureGuguKey({ dir, comment: 'gugu@test', keygen })).rejects.toThrow()
    expect(keygen).not.toHaveBeenCalled()
  })
})

describe('installGuguKey:装一次 + 验一次', () => {
  function keyDir(): string {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'id_ed25519'), 'PRIVATE')
    fs.writeFileSync(path.join(dir, 'id_ed25519.pub'), PUB)
    return dir
  }
  const target = { destination: 'alice@box', display: 'alice@box' }
  function fakeSsh(install: { stdout: string; code?: number }, verify: { code: number; stderr?: string }) {
    const calls: Array<{ args: string[]; stdin: string }> = []
    const spawnSsh: SpawnSsh = async (args, { stdin }) => {
      calls.push({ args, stdin: typeof stdin === 'string' ? stdin : '' })
      if (args.includes('BatchMode=yes')) return { code: verify.code, stdout: '', stderr: verify.stderr ?? '' }
      return { code: install.code ?? 0, stdout: install.stdout, stderr: '' }
    }
    return { spawnSsh, calls }
  }

  it('装上且验证过 = installed,带回钥匙路径;装进去的是公钥那一行,❌ 私钥', async () => {
    const dir = keyDir()
    const ssh = fakeSsh({ stdout: '__GUGU_KEY_ADDED__\n' }, { code: 0 })
    const outcome = await installGuguKey({ target, controlPath: '/tmp/cm', spawnSsh: ssh.spawnSsh, key: { dir }, comment: 'gugu@mbp' })
    expect(outcome).toEqual({ status: 'installed', keyPath: path.join(dir, 'id_ed25519') })
    expect(ssh.calls[0]!.stdin).toContain(`ssh-ed25519 ${BLOB} gugu@mbp`)
    expect(ssh.calls.map((c) => c.stdin).join('')).not.toContain('PRIVATE')
  })

  it('本来就在、验证过 = installed(不追加第二次)', async () => {
    const ssh = fakeSsh({ stdout: '__GUGU_KEY_PRESENT__\n' }, { code: 0 })
    expect((await installGuguKey({ target, controlPath: null, spawnSsh: ssh.spawnSsh, key: { dir: keyDir() } })).status).toBe('installed')
  })

  it('那台机器不收钥匙登录(PubkeyAuthentication no / 钥匙文件在别处):装了也验不过 = not-accepted', async () => {
    const ssh = fakeSsh({ stdout: '__GUGU_KEY_ADDED__\n' }, { code: 255, stderr: 'alice@box: Permission denied (password).' })
    expect(await installGuguKey({ target, controlPath: null, spawnSsh: ssh.spawnSsh, key: { dir: keyDir() } })).toEqual({
      status: 'failed',
      reason: 'not-accepted',
    })
  })

  it('写不进去 = write-failed,❌ 再去验;没连上 = unreachable;生成不了钥匙 = no-key', async () => {
    const ro = fakeSsh({ stdout: '__GUGU_KEY_WRITE_FAILED__\n' }, { code: 0 })
    expect(await installGuguKey({ target, controlPath: null, spawnSsh: ro.spawnSsh, key: { dir: keyDir() } })).toEqual({
      status: 'failed',
      reason: 'write-failed',
    })
    expect(ro.calls).toHaveLength(1)
    const gone = fakeSsh({ stdout: '', code: 255 }, { code: 0 })
    expect((await installGuguKey({ target, controlPath: null, spawnSsh: gone.spawnSsh, key: { dir: keyDir() } })).status).toBe('failed')
    const noKeygen = fakeSsh({ stdout: '' }, { code: 0 })
    const outcome = await installGuguKey({
      target,
      controlPath: null,
      spawnSsh: noKeygen.spawnSsh,
      key: { dir: path.join(tempDir(), 'ssh'), keygen: async () => Promise.reject(new Error('ENOENT')) },
    })
    expect(outcome).toEqual({ status: 'failed', reason: 'no-key' })
    expect(noKeygen.calls).toHaveLength(0)
  })
})

describe('提问与勾选(broker)', () => {
  function broker(offerKeyInstall: boolean) {
    const shown: SshPrompt[] = []
    const b = createSshPromptBroker({ home: '/home/a', offerKeyInstall, onPrompt: (p) => p && shown.push(p) })
    const ask = (message: string) => {
      const answer = b.handler({ prompt: message, mode: '', signal: new AbortController().signal })
      return { prompt: shown.at(-1)!, answer }
    }
    return { b, ask }
  }

  it('只有登录密码(含键盘交互的 Password:)带「下次免密」;口令 / 验证码 / 指纹 ❌;卸载那种不带', async () => {
    const { b, ask } = broker(true)
    expect(ask("alice@box's password: ").prompt.offerKeyInstall).toBe(true)
    b.cancelAll()
    expect(ask('(alice@box) Password: ').prompt.offerKeyInstall).toBe(true)
    b.cancelAll()
    expect(ask("Enter passphrase for key '/home/a/.ssh/id_ed25519': ").prompt.offerKeyInstall).toBeUndefined()
    b.cancelAll()
    expect(ask('Verification code: ').prompt.offerKeyInstall).toBeUndefined()
    b.cancelAll()
    const off = broker(false)
    expect(off.ask("alice@box's password: ").prompt.offerKeyInstall).toBeUndefined()
  })

  it('勾了就记下密码,取一次就清;以最后一次回答为准;新一轮清掉;没开这项时勾了也不记', async () => {
    const { b, ask } = broker(true)
    let q = ask("alice@box's password: ")
    b.answer(q.prompt.id, 'wrong', { installKey: true })
    await q.answer
    q = ask("alice@box's password: ")
    b.answer(q.prompt.id, 'right', { installKey: true })
    expect(b.takeKeyRequest()).toEqual({ password: 'right' })
    expect(b.takeKeyRequest()).toBeNull()
    q = ask("alice@box's password: ")
    b.answer(q.prompt.id, 'x', { installKey: true })
    q = ask("alice@box's password: ")
    b.answer(q.prompt.id, 'y')
    expect(b.takeKeyRequest()).toBeNull()
    q = ask("alice@box's password: ")
    b.answer(q.prompt.id, 'z', { installKey: true })
    b.newRound()
    expect(b.takeKeyRequest()).toBeNull()
    const off = broker(false)
    const r = off.ask("alice@box's password: ")
    off.b.answer(r.prompt.id, 'z', { installKey: true })
    expect(off.b.takeKeyRequest()).toBeNull()
  })
})

describe('直连终端的 askpass:登上之后才装,结果报给听的人(关了也报)', () => {
  it('勾了 + 登上 = 用刚才的密码去装一次;没勾 / 没登上 = 什么都不做', async () => {
    let handler: AskpassHandler | null = null
    const open = (async (h: AskpassHandler) => {
      handler = h
      return { dir: '/tmp/x', env: {}, close: async () => undefined }
    }) as typeof openAskpassWorkspace
    const installKey = vi.fn(async () => ({ status: 'installed' as const }))
    const askpass = await createTerminalAskpass(open, installKey)
    const prompts: Array<SshPrompt | null> = []
    askpass.onPrompt((p) => prompts.push(p))
    const outcomes: unknown[] = []
    askpass.onKeyInstall?.((o) => outcomes.push(o))
    askpass.authenticated?.()
    expect(installKey).not.toHaveBeenCalled()
    void handler!({ prompt: "alice@box's password: ", mode: '', signal: new AbortController().signal })
    const prompt = prompts.at(-1)!
    expect(prompt.offerKeyInstall).toBe(true)
    askpass.answer(prompt.id, 's3cret', { installKey: true })
    await askpass.close()
    askpass.authenticated?.()
    await vi.waitFor(() => expect(outcomes).toEqual([{ status: 'installed' }]))
    expect(installKey).toHaveBeenCalledWith('s3cret')
    askpass.authenticated?.()
    expect(installKey).toHaveBeenCalledTimes(1)
  })
})

describe('装好之后把钥匙关联到机器', () => {
  const machine: SshMachine = {
    deviceId: 'dev1',
    ownerUserId: 'u1',
    destination: 'alice@box',
    display: 'alice@box',
    addedAt: '2026-09-24T00:00:00Z',
    options: ['-J', 'jump'],
  }
  function store(initial: SshMachine[]) {
    let machines = initial
    return {
      list: () => machines,
      remember: vi.fn((m: SshMachine) => {
        machines = [...machines.filter((x) => x.deviceId !== m.deviceId), m]
      }),
    }
  }

  it('验证过才记:以此刻存着的那条为准,只多一个 IdentityFile;没做成 ❌ 动记录、❌ 把钥匙路径交给界面', async () => {
    const s = store([machine])
    const ok = createMachineKeyInstaller({
      store: s,
      keyDir: '/d/ssh',
      install: async () => ({ status: 'installed', keyPath: '/d/ssh/id_ed25519' }),
    })
    expect(await ok(machine, '/tmp/cm', 'pw')).toEqual({ status: 'installed' })
    expect(s.list()[0]!.options).toEqual(['-J', 'jump', '-o', 'IdentityFile=/d/ssh/id_ed25519'])
    const s2 = store([machine])
    const bad = createMachineKeyInstaller({ store: s2, keyDir: '/d/ssh', install: async () => ({ status: 'failed', reason: 'not-accepted' }) })
    expect(await bad(machine, null, 'pw')).toEqual({ status: 'failed', reason: 'not-accepted' })
    expect(s2.remember).not.toHaveBeenCalled()
  })

  it('直连(端口转发)的 resolver:给了 installKey 才把「装钥匙」交给 askpass(带着这台机器与复用连接的路径)', async () => {
    const purpose = { kind: 'forward' as const, localPort: 4000, remotePort: 3000 }
    const s = store([machine])
    const factory = vi.fn(async (install?: (password: string) => Promise<unknown>) => {
      if (install) await install('pw')
      return { env: {}, onPrompt: () => undefined, onSettled: () => undefined, answer: () => false, newRound: () => undefined, cancelAll: () => undefined, close: async () => undefined }
    })
    const installKey = vi.fn(async () => ({ status: 'installed' as const }))
    const resolver = createDirectTerminalResolver({ store: s, currentUserId: async () => 'u1', controlPath: () => '/tmp/cm-%C', askpass: factory, installKey })
    await resolver({ deviceId: 'dev1', sessionId: 'c1', purpose })
    expect(installKey).toHaveBeenCalledWith(machine, '/tmp/cm-%C', 'pw')
    const plain = createDirectTerminalResolver({ store: s, currentUserId: async () => 'u1', controlPath: () => null, askpass: factory })
    await plain({ deviceId: 'dev1', sessionId: 'c1', purpose })
    expect(factory.mock.calls.at(-1)![0]).toBeUndefined()
  })
})
