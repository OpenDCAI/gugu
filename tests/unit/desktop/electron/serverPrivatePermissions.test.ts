// #6264 实机:咕咕 server 由 systemd 用户服务拉起时继承了用户管理器的 umask 0002(Ubuntu 每用户同名组),
// ~/.gugu-server 整棵树成了 drwxrwxr-x,codex app-server 以「socket parent must be owned by the user or root and
// prevent other users from replacing socket entries」拒绝启动。这里钉住:服务 umask 与登录 shell 一致(0022)、server 自己的根 0700 + 老机器启动时收紧。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  desiredMode,
  ensurePrivateDir,
  SERVICE_UMASK,
  summarizeChanges,
  tightenServerTree,
} from '../../../../apps/desktop/electron/server/server-permissions'
import { launchdPlist, systemdUnit } from '../../../../apps/desktop/electron/server/server-service'
import { codexSocketDir, ensurePrivateSocketDir } from '../../../../apps/desktop/electron/sessionpage/codex-app-server-transport'

const posix = process.platform !== 'win32'
const mode = (p: string) => fs.lstatSync(p).mode & 0o777

describe('进程 umask 跟登录 shell 一样,server 自己的数据靠 0700 的根', () => {
  const entrySrc = () => fs.readFileSync(path.join(__dirname, '../../../../apps/desktop/electron/server-entry.ts'), 'utf8')

  it('server 入口不收紧全局 umask(项目里新建的文件要跟用户自己建的一样)', () => {
    expect(entrySrc()).not.toMatch(/process\.umask\(/)
  })

  it('server 入口在任何命令之前把数据目录的根收成 0700', () => {
    const src = entrySrc()
    const call = src.indexOf('ensurePrivateDir(serverHome)')
    expect(call).toBeGreaterThan(src.indexOf('const serverHome = resolveServerHome()'))
    expect(call).toBeLessThan(src.indexOf('async function runCommand('))
  })

  it('systemd 用户服务写明 UMask=0022(压住用户管理器的 0002,但不收成 0077)', () => {
    const unit = systemdUnit('/h/.gugu-server/current/bin/gugu-server', '/h/.gugu-server')
    expect(unit).toMatch(/^\[Service\][\s\S]*^UMask=0022$/m)
    expect(SERVICE_UMASK).toBe(0o022)
  })

  it('launchd 用户代理写明 Umask 0022(十进制 18)', () => {
    const plist = launchdPlist('/h/bin/gugu-server', '/h/.gugu-server', '/h/log')
    expect(plist).toContain(`<key>Umask</key><integer>${SERVICE_UMASK}</integer>`)
    expect(SERVICE_UMASK).toBe(18)
  })

  it('install.sh 把数据目录建成 0700', () => {
    const sh = fs.readFileSync(path.join(__dirname, '../../../../scripts/gugu-server/install.sh'), 'utf8')
    expect(sh).toContain('chmod 700 "$SERVER_HOME"')
    expect(sh.indexOf('chmod 700 "$SERVER_HOME"')).toBeLessThan(sh.indexOf('mkdir -p "$SERVER_HOME/versions"'))
  })
})

describe.runIf(posix)('ensurePrivateDir(server 自己的根)', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-root-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('宽松 umask 下新建的是 0700;已存在的 0775 收回 0700', () => {
    const previous = process.umask(0o002)
    try {
      const fresh = path.join(root, 'a', '.gugu-server')
      ensurePrivateDir(fresh)
      expect(mode(fresh)).toBe(0o700)
      const old = path.join(root, 'old')
      fs.mkdirSync(old)
      fs.chmodSync(old, 0o775)
      ensurePrivateDir(old)
      expect(mode(old)).toBe(0o700)
    } finally {
      process.umask(previous)
    }
  })

  it('根是 0700 时,里面后来按宽松 umask 建的东西别人也进不去(根挡住)', () => {
    const home = path.join(root, '.gugu-server')
    ensurePrivateDir(home)
    const previous = process.umask(0o002)
    try {
      fs.mkdirSync(path.join(home, 'later'), { recursive: true })
    } finally {
      process.umask(previous)
    }
    expect(mode(home) & 0o077).toBe(0)
  })

  it('软链不当根用', () => {
    fs.mkdirSync(path.join(root, 'real'))
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'))
    expect(() => ensurePrivateDir(path.join(root, 'link'))).toThrow()
  })
})

describe('desiredMode', () => {
  it('目录 → 0700,密钥/登录态 → 0600,其余文件去掉组和其他人', () => {
    expect(desiredMode('dir', 'accounts', 0o40775)).toBe(0o700)
    expect(desiredMode('dir', 'accounts', 0o40700)).toBeNull()
    expect(desiredMode('file', 'server-session.enc', 0o100644)).toBe(0o600)
    expect(desiredMode('file', 'task-host-secret.key', 0o100600)).toBeNull()
    expect(desiredMode('file', 'gugu-main.log', 0o100664)).toBe(0o600)
    expect(desiredMode('file', 'codex', 0o100775)).toBe(0o700)
    expect(desiredMode('file', 'agents.json', 0o100600)).toBeNull()
  })
})

describe.runIf(posix)('tightenServerTree(老机器修复)', () => {
  let root: string
  let home: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-perm-'))
    home = path.join(root, '.gugu-server')
    const mk = (rel: string, m: number) => {
      fs.mkdirSync(path.join(home, rel), { recursive: true })
      fs.chmodSync(path.join(home, rel), m)
    }
    const file = (rel: string, m: number) => {
      fs.writeFileSync(path.join(home, rel), 'x')
      fs.chmodSync(path.join(home, rel), m)
    }
    mk('', 0o775)
    mk('data/logs', 0o775)
    mk('data/acp-attachments', 0o775)
    mk('accounts/u1/home/agents/mise-bin', 0o775)
    mk('accounts/u1/data', 0o775)
    mk('versions/0.2.117/app/node_modules/x', 0o755)
    mk('accounts/u1/home/agents/mise/installs/node_modules/pkg', 0o775)
    mk('accounts/u1/home/projects/repo/.git', 0o775)
    mk('accounts/u1/home/projects/repo/src', 0o775)
    mk('accounts/u1/home/projects/repo', 0o775)
    file('accounts/u1/data/server-session.enc', 0o644)
    file('accounts/u1/data/task-host-secret.key', 0o664)
    file('data/logs/supervisor.log', 0o664)
    file('accounts/u1/home/projects/repo/src/a.ts', 0o664)
    // 数据目录外面的东西,经软链指过去也不许碰
    fs.mkdirSync(path.join(root, 'outside'), { mode: 0o775 })
    fs.chmodSync(path.join(root, 'outside'), 0o775)
    fs.symlinkSync(path.join(root, 'outside'), path.join(home, 'accounts/u1/home/link'))
    fs.symlinkSync('versions/0.2.117', path.join(home, 'current'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('目录收到 0700、密钥 0600,记下每一项改动', () => {
    const changes = tightenServerTree(home)
    for (const rel of ['', 'data', 'data/logs', 'data/acp-attachments', 'accounts', 'accounts/u1', 'accounts/u1/home', 'accounts/u1/home/agents', 'accounts/u1/home/agents/mise-bin', 'accounts/u1/data']) {
      expect(mode(path.join(home, rel)), rel).toBe(0o700)
    }
    expect(mode(path.join(home, 'accounts/u1/data/server-session.enc'))).toBe(0o600)
    expect(mode(path.join(home, 'accounts/u1/data/task-host-secret.key'))).toBe(0o600)
    expect(mode(path.join(home, 'data/logs/supervisor.log'))).toBe(0o600)
    expect(changes.some((c) => c.path === home && c.from === 0o775 && c.to === 0o700)).toBe(true)
    expect(summarizeChanges(changes).count).toBe(changes.length)
    // 第二次启动:没有要改的了
    expect(tightenServerTree(home)).toEqual([])
  })

  it('不碰:git 仓库(用户项目)、软链指向的外部目录、安装包内部、node_modules 内部', () => {
    tightenServerTree(home)
    expect(mode(path.join(home, 'accounts/u1/home/projects/repo'))).toBe(0o775)
    expect(mode(path.join(home, 'accounts/u1/home/projects/repo/src'))).toBe(0o775)
    expect(mode(path.join(home, 'accounts/u1/home/projects/repo/src/a.ts'))).toBe(0o664)
    expect(mode(path.join(root, 'outside'))).toBe(0o775)
    expect(mode(path.join(home, 'versions/0.2.117'))).toBe(0o700)
    expect(mode(path.join(home, 'versions/0.2.117/app'))).toBe(0o755)
    expect(mode(path.join(home, 'accounts/u1/home/agents/mise/installs/node_modules/pkg'))).toBe(0o775)
  })

  it('不是本人的东西不碰(注入 uid)', () => {
    expect(tightenServerTree(home, { uid: -1 })).toEqual([])
    expect(mode(home)).toBe(0o775)
  })

  it('数据目录不存在:什么也不做', () => {
    expect(tightenServerTree(path.join(root, 'nope'))).toEqual([])
  })
})

describe.runIf(posix)('codex app-server 套接字目录', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cxdir-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('按用户分目录(/tmp 整机共用)', () => {
    expect(codexSocketDir('/tmp')).toBe(`/tmp/gugu-cx-${process.getuid!()}`)
  })

  it('旧版本建成 0775 的目录收回 0700', () => {
    const dir = path.join(root, 'gugu-cx-1')
    fs.mkdirSync(dir)
    fs.chmodSync(dir, 0o775)
    expect(ensurePrivateSocketDir(dir)).toBe(true)
    expect(mode(dir)).toBe(0o700)
  })

  it('宽松 umask 下新建的也是 0700', () => {
    const previous = process.umask(0o002)
    try {
      const dir = path.join(root, 'fresh')
      expect(ensurePrivateSocketDir(dir)).toBe(true)
      expect(mode(dir)).toBe(0o700)
    } finally {
      process.umask(previous)
    }
  })

  it('软链(可能被别人换掉)不用', () => {
    fs.mkdirSync(path.join(root, 'real'))
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'))
    expect(ensurePrivateSocketDir(path.join(root, 'link'))).toBe(false)
  })
})
