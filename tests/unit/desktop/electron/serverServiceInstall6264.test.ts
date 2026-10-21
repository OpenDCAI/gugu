// #6264 `gugu-server service install` 的交付是「结束时在跑的就是这一版」(product spec 第 5 条:
// 急用可在那台机器上重新执行安装命令)。实机踩到:旧版本在跑,兜底模式新起的进程撞在单实例锁上退出,却报了「已在后台启动」。
import { describe, expect, it } from 'vitest'
import {
  chooseServiceMode,
  cronQuote,
  systemdQuote,
  systemdUnit,
  describeProcess,
  installServiceWith,
  type InstallServiceDeps,
  type RunningServer,
  type ServiceMode,
} from '../../../../apps/desktop/electron/server/server-service'

type Proc = { pid: number; version: string; supervisedBy: RunningServer['supervisedBy']; alive: boolean; waitFor?: number }

/**
 * 一台假机器:进程表 + 单实例锁 + 一个按 Restart=always / KeepAlive 行事的服务管理器。
 * 每次 sleep 走一拍:收到 SIGTERM 的进程过 stopTicks 拍退出;等锁的进程在锁空出来后接上;管理器那一份死了就按 current 拉起。
 */
function fakeMachine(options: {
  mode: ServiceMode
  old?: { version: string; supervisedBy: RunningServer['supervisedBy'] }
  current: string
  busy?: boolean
  /** 旧进程收到 SIGTERM 后几拍退出;Infinity = 卡死不退。 */
  stopTicks?: number
  /** 管理器拉起来的新进程起不来(比如新包在这台机器上跑不了)。 */
  newCrashes?: boolean
}) {
  const procs: Proc[] = []
  let nextPid = 100
  let lock: number | null = null
  let managerWants = false
  const stopping = new Map<number, number>()
  const calls: string[] = []
  const spawnProc = (supervisedBy: RunningServer['supervisedBy'], waitFor?: number): Proc => {
    const proc: Proc = { pid: nextPid++, version: options.current, supervisedBy, alive: !options.newCrashes, waitFor }
    procs.push(proc)
    return proc
  }
  const tryLock = (proc: Proc) => {
    if (proc.alive && lock === null && (proc.waitFor === undefined || !procs.find((p) => p.pid === proc.waitFor)?.alive)) lock = proc.pid
  }
  const managerSupervisor = options.mode === 'launchd' ? 'launchd' : 'systemd'
  const tick = () => {
    for (const [pid, left] of stopping) {
      if (left > 1) stopping.set(pid, left - 1)
      else {
        stopping.delete(pid)
        const proc = procs.find((p) => p.pid === pid)
        if (proc) proc.alive = false
        if (lock === pid) lock = null
      }
    }
    for (const proc of procs) tryLock(proc)
    // Restart=always:管理器那一份不在跑(死了、或撞锁退了)就再起一份
    if (managerWants && !procs.some((p) => p.alive && p.supervisedBy === managerSupervisor && lock === p.pid)) {
      for (const p of procs) if (p.supervisedBy === managerSupervisor && lock !== p.pid) p.alive = false
      tryLock(spawnProc(managerSupervisor))
    }
  }
  if (options.old) {
    const proc: Proc = { pid: nextPid++, ...options.old, alive: true }
    procs.push(proc)
    lock = proc.pid
    // 旧的归管理器管(systemd / launchd):管理器本来就在盯着它
    if (options.old.supervisedBy === 'systemd' || options.old.supervisedBy === 'launchd') managerWants = true
  }
  const stop = (pid: number) => {
    calls.push(`stop ${pid}`)
    const ticks = options.stopTicks ?? 2
    if (Number.isFinite(ticks)) stopping.set(pid, ticks)
  }
  let clock = 0
  const lines: string[] = []
  const deps: InstallServiceDeps = {
    mode: options.mode,
    targetVersion: options.current,
    running: () => {
      const proc = procs.find((p) => p.pid === lock && p.alive)
      return proc ? { pid: proc.pid, version: proc.version, supervisedBy: proc.supervisedBy } : null
    },
    isAlive: (pid) => procs.some((p) => p.pid === pid && p.alive),
    isBusy: () => options.busy ?? false,
    stop,
    registerSystemd: (out) => {
      calls.push('systemd restart')
      managerWants = true
      // systemctl restart 同步停掉它自己那一份,再起一份(撞锁就等下一拍重试)
      for (const p of procs) if (p.supervisedBy === 'systemd' && p.alive) {
        p.alive = false
        if (lock === p.pid) lock = null
      }
      tryLock(spawnProc('systemd'))
      out('已注册为 systemd 用户服务(~/.config/systemd/user/gugu-server.service)。')
    },
    registerLaunchd: (out) => {
      calls.push('launchd bootstrap')
      managerWants = true
      for (const p of procs) if (p.supervisedBy === 'launchd' && p.alive) {
        p.alive = false
        if (lock === p.pid) lock = null
      }
      tryLock(spawnProc('launchd'))
      out('已注册为 launchd 用户代理。')
    },
    registerCron: () => {
      calls.push('cron')
      return true
    },
    startDetached: (waitPid) => {
      calls.push(`detached wait=${waitPid ?? '-'}`)
      const proc = spawnProc('none', waitPid)
      tryLock(proc)
      return proc.pid
    },
    logHint: 'service.log',
    user: 'alice',
    sleep: async (ms) => {
      clock += ms
      tick()
    },
    now: () => clock,
  }
  return { deps, calls, lines, out: (line: string) => void lines.push(line), running: () => deps.running() }
}

describe('service install:结束时在跑的就是这一版', () => {
  it('兜底模式、旧版本在跑且有 agent 在干活:先明说会中断,新的等旧的退干净再接上,报出真实的版本与进程号', async () => {
    const m = fakeMachine({ mode: 'fallback', old: { version: '0.2.111', supervisedBy: 'none' }, current: '0.2.112', busy: true })
    expect(await installServiceWith(m.out, m.deps)).toBe(true)
    expect(m.calls).toEqual(['cron', 'detached wait=100', 'stop 100'])
    const text = m.lines.join('\n')
    expect(text).toContain('正在把 咕咕 server 0.2.111(进程 100)换成 0.2.112')
    expect(text).toContain('这一轮会被中断')
    expect(m.running()).toMatchObject({ version: '0.2.112', supervisedBy: 'none' })
    expect(m.lines.at(-1)).toBe(`咕咕 server 0.2.112 已在运行(进程 ${m.running()?.pid})。`)
    // ❌ 在确认之前就说「已在后台启动」
    expect(text).not.toContain('已在后台启动')
  })

  it('没有 agent 在干活时不吓人', async () => {
    const m = fakeMachine({ mode: 'fallback', old: { version: '0.2.111', supervisedBy: 'none' }, current: '0.2.112' })
    expect(await installServiceWith(m.out, m.deps)).toBe(true)
    expect(m.lines.join('\n')).not.toContain('中断')
  })

  it('旧的卡着不退:不报成功,说清先 stop 再 service install', async () => {
    const m = fakeMachine({ mode: 'fallback', old: { version: '0.2.111', supervisedBy: 'none' }, current: '0.2.112', stopTicks: Infinity })
    expect(await installServiceWith(m.out, m.deps)).toBe(false)
    const text = m.lines.join('\n')
    expect(text).toContain('旧的 咕咕 server 0.2.111(进程 100)没有退出')
    expect(text).toContain('gugu-server stop')
    expect(text).not.toContain('已在运行')
  })

  it('新版本起不来:说没跑起来、去哪看日志', async () => {
    const m = fakeMachine({ mode: 'fallback', current: '0.2.112', newCrashes: true })
    expect(await installServiceWith(m.out, m.deps)).toBe(false)
    expect(m.lines.at(-1)).toContain('server 没有启动。日志:service.log')
  })

  it('同一版已经在跑:不重启(❌ 平白打断 agent)', async () => {
    const m = fakeMachine({ mode: 'systemd', old: { version: '0.2.112', supervisedBy: 'systemd' }, current: '0.2.112', busy: true })
    expect(await installServiceWith(m.out, m.deps)).toBe(true)
    expect(m.calls).toEqual([])
    // 标记行让后台升级分清「本来就是这一版」与「当场切过去了」(ssh-install/runner.ts)。
    expect(m.lines).toEqual(['咕咕 server 0.2.112 已在运行(进程 100)。'])
  })

  it('systemd:restart 把它自己那一份换到新版本', async () => {
    const m = fakeMachine({ mode: 'systemd', old: { version: '0.2.111', supervisedBy: 'systemd' }, current: '0.2.112' })
    expect(await installServiceWith(m.out, m.deps)).toBe(true)
    expect(m.calls).toEqual(['systemd restart'])
    expect(m.running()).toMatchObject({ version: '0.2.112', supervisedBy: 'systemd' })
  })

  it('systemd 可用了,但在跑的是以前兜底起的那个:停掉它,systemd 那一份接上(❌ 两份抢锁)', async () => {
    const m = fakeMachine({ mode: 'systemd', old: { version: '0.2.111', supervisedBy: 'none' }, current: '0.2.112' })
    expect(await installServiceWith(m.out, m.deps)).toBe(true)
    expect(m.calls).toEqual(['systemd restart', 'stop 100'])
    expect(m.running()).toMatchObject({ version: '0.2.112', supervisedBy: 'systemd' })
  })

  it('launchd:重新 bootstrap 换到新版本', async () => {
    const m = fakeMachine({ mode: 'launchd', old: { version: '0.2.111', supervisedBy: 'unknown' }, current: '0.2.112' })
    // macOS 读不到别的进程的环境:托管方 unknown,旧的不归 launchd 管时同样被停掉、由 KeepAlive 接上
    expect(await installServiceWith(m.out, m.deps)).toBe(true)
    expect(m.calls[0]).toBe('launchd bootstrap')
    expect(m.running()?.version).toBe('0.2.112')
  })

  it('注册过 systemd 用户服务、当前 shell 连不上(su / docker exec):停掉旧的让 systemd 按新版本拉起,❌ 另起一份、❌ 写 crontab', async () => {
    const m = fakeMachine({ mode: 'systemdUnreachable', old: { version: '0.2.111', supervisedBy: 'systemd' }, current: '0.2.112' })
    expect(await installServiceWith(m.out, m.deps)).toBe(true)
    expect(m.calls).toEqual(['stop 100'])
    expect(m.running()).toMatchObject({ version: '0.2.112', supervisedBy: 'systemd' })
    expect(m.lines.join('\n')).toContain('改由 systemd 以新版本重启')
  })

  it('连不上 systemd 用户会话、也没在跑:不起重复的,说清以谁的身份执行什么', async () => {
    const m = fakeMachine({ mode: 'systemdUnreachable', current: '0.2.112' })
    expect(await installServiceWith(m.out, m.deps)).toBe(false)
    expect(m.calls).toEqual([])
    const text = m.lines.join('\n')
    expect(text).toContain('以 alice 直接 SSH 登录后执行:gugu-server service install')
    expect(text).toContain('sudo loginctl enable-linger alice')
  })
})

describe('选哪种常驻方式', () => {
  it('有 systemd 用户服务文件、却连不上用户会话时,不退回兜底', () => {
    expect(chooseServiceMode({ platform: 'darwin', systemdReachable: false, unitExists: false })).toBe('launchd')
    expect(chooseServiceMode({ platform: 'linux', systemdReachable: true, unitExists: true })).toBe('systemd')
    expect(chooseServiceMode({ platform: 'linux', systemdReachable: false, unitExists: true })).toBe('systemdUnreachable')
    expect(chooseServiceMode({ platform: 'linux', systemdReachable: false, unitExists: false })).toBe('fallback')
  })
})

describe('认出在跑的那个是哪一版、谁在管', () => {
  it('Linux:从 /proc/<pid>/environ 读', () => {
    const environ = ['PATH=/usr/bin', 'GUGU_TASK_HOST_VERSION=0.2.111', 'GUGU_SERVER_SUPERVISED=systemd', ''].join('\0')
    expect(describeProcess(7, environ, null)).toEqual({ pid: 7, version: '0.2.111', supervisedBy: 'systemd' })
    // 兜底起的:变量在但为空
    expect(describeProcess(7, 'GUGU_TASK_HOST_VERSION=0.2.111\0GUGU_SERVER_SUPERVISED=\0', null).supervisedBy).toBe('none')
  })

  it('macOS:读不到环境,从命令行里的 versions/<版本>/ 认', () => {
    const cmd = '/Users/a b/.gugu-server/versions/0.2.111/node/bin/node /Users/a b/.gugu-server/versions/0.2.111/app/dist-electron/server.js run'
    expect(describeProcess(7, null, cmd)).toEqual({ pid: 7, version: '0.2.111', supervisedBy: 'unknown' })
    expect(describeProcess(7, null, '/opt/dev/node server.js run').version).toBeNull()
  })
})

describe('单元文件 / crontab 里的路径(#6264 gap 24)', () => {
  it('带空格、引号、% 与 $ 的路径在 systemd 单元里原样成立', () => {
    const unit = systemdUnit('/home/a b/.local/bin/gugu-server', '/home/a b/.gugu-server')
    expect(unit).toContain('ExecStart="/home/a b/.local/bin/gugu-server" run')
    expect(unit).toContain('Environment="GUGU_SERVER_HOME=/home/a b/.gugu-server"')
    expect(systemdQuote('/x/50%/"q"/$HOME', { execLine: true })).toBe('"/x/50%%/\\"q\\"/$$HOME"')
    expect(systemdQuote('/x/$HOME')).toBe('"/x/$HOME"')
  })

  it('crontab 那一行:单引号与 % 都转义', () => {
    expect(cronQuote("/home/o'neil/50%")).toBe("'/home/o'\\''neil/50\\%'")
  })
})
