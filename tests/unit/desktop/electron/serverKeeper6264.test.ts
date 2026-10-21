// #6264 兜底模式(没有 systemd 的容器 / WSL)的看门人:守护进程崩了、被 OOM / kill -9 杀了要有人拉起;
// 有人明确要停、被新看门人接替、另一个守护进程已在跑时要收手。真跑 /bin/sh 看门人脚本,假的 gugu-server 只记账。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { awaitExit, awaitFact } from '../../../support/awaitFact'
import {
  keeperPidFile,
  keeperScript,
  liveKeeperPid,
  resolveLoginShell,
  SUPERVISOR_EXIT_ALREADY_RUNNING,
} from '../../../../apps/desktop/electron/server/server-keeper'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * 假安装:current/bin/gugu-server 每跑一次在 runs 里记一行「第几次 + 看到的环境」,
 * 然后按 exits 文件里对应那一行的退出码退出(没有那一行就 0)。
 */
function fakeInstall(exits: number[]): { home: string; runs: () => string[] } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-keeper-'))
  dirs.push(home)
  const bin = path.join(home, 'versions', '1.0.0', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(path.join(home, 'data'), { recursive: true })
  fs.writeFileSync(path.join(home, 'exits'), exits.join('\n') + '\n')
  fs.writeFileSync(
    path.join(bin, 'gugu-server'),
    [
      '#!/bin/sh',
      `H='${home}'`,
      'n=$(($(cat "$H/runs" 2>/dev/null | wc -l) + 1))',
      'echo "$n $1 sup=$GUGU_SERVER_SUPERVISED wait=$GUGU_SERVER_WAIT_PID" >> "$H/runs"',
      'code=$(sed -n "${n}p" "$H/exits")',
      'exit ${code:-0}',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  fs.symlinkSync('versions/1.0.0', path.join(home, 'current'))
  return { home, runs: () => (fs.existsSync(path.join(home, 'runs')) ? fs.readFileSync(path.join(home, 'runs'), 'utf8').trim().split('\n') : []) }
}

/**
 * 跑完看门人(脚本里的 sleep 换成 0,测试不用等 3 秒)。等它退出这个事实,❌ 给 20 s 上限:假 gugu-server 每条用例
 * 都是新写出来的可执行文件,macOS 对它的首次 execve 要过一道全机串行的检查,满载时单次就能到几十秒(见 awaitFact.ts)。
 */
async function runKeeper(home: string, options: { waitPid?: number } = {}): Promise<void> {
  const script = keeperScript(home, { waitPid: options.waitPid }).replace(/sleep \d+/g, 'sleep 0')
  const keeper = spawn('/bin/sh', ['-c', script], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  keeper.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const { code, signal } = await awaitExit('看门人跑完', keeper)
  expect({ code, signal }, stderr).toEqual({ code: 0, signal: null })
}

describe('看门人', () => {
  it('守护进程崩了就再拉起,直到它说「另一个已经在跑」为止', async () => {
    const { home, runs } = fakeInstall([1, 137, SUPERVISOR_EXIT_ALREADY_RUNNING])
    await runKeeper(home, { waitPid: 4242 })
    const lines = runs()
    expect(lines).toHaveLength(3)
    // 第一轮带上要等的旧进程,之后不再带;每一轮都标明是看门人拉起的。
    expect(lines[0]).toBe('1 run sup=keeper wait=4242')
    expect(lines[1]).toBe('2 run sup=keeper wait=')
    // 收手时把自己的 pid 文件也收掉。
    expect(fs.existsSync(path.join(home, 'data', 'keeper.pid'))).toBe(false)
  })

  it('有人明确要停(data/stopped):守护进程退出后不再拉起', async () => {
    const { home, runs } = fakeInstall([0, 0, 0])
    // 假守护进程第一次跑时顺手写下 stopped,模拟 `gugu-server stop` / SIGTERM。
    fs.appendFileSync(path.join(home, 'versions', '1.0.0', 'bin', 'gugu-server'), '')
    const bin = path.join(home, 'versions', '1.0.0', 'bin', 'gugu-server')
    fs.writeFileSync(bin, fs.readFileSync(bin, 'utf8').replace('exit ${code:-0}', `touch '${home}/data/stopped'; exit \${code:-0}`))
    await runKeeper(home)
    expect(runs()).toHaveLength(1)
  })

  it('第一轮不看 stopped:接班时旧守护进程写下的记号是说给旧看门人听的', async () => {
    const { home, runs } = fakeInstall([0, SUPERVISOR_EXIT_ALREADY_RUNNING])
    fs.writeFileSync(path.join(home, 'data', 'stopped'), '')
    const bin = path.join(home, 'versions', '1.0.0', 'bin', 'gugu-server')
    // 真守护进程启动时会清掉 stopped(server-supervisor.ts);假的也照做。
    fs.writeFileSync(bin, fs.readFileSync(bin, 'utf8').replace('echo "$n', `rm -f '${home}/data/stopped'; echo "$n`))
    await runKeeper(home)
    expect(runs()).toHaveLength(2)
  })

  it('被新的看门人接替(keeper.pid 不再是自己):守护进程退出后收手', async () => {
    const { home, runs } = fakeInstall([0, 0, 0])
    const bin = path.join(home, 'versions', '1.0.0', 'bin', 'gugu-server')
    fs.writeFileSync(bin, fs.readFileSync(bin, 'utf8').replace('exit ${code:-0}', `echo 999999 > '${home}/data/keeper.pid'; exit \${code:-0}`))
    await runKeeper(home)
    expect(runs()).toHaveLength(1)
  })

  it('接手一个已在跑的守护进程:等它退了才开始拉起', async () => {
    const { home, runs } = fakeInstall([SUPERVISOR_EXIT_ALREADY_RUNNING])
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
    // 看门人每绕一圈先记一笔再睡。「接手期间没拉起」要在它真的看过被接手的进程之后判:等它绕过两圈 ——
    // ❌ 固定睡 600 ms(CI 满载时 sh 还没跑到第一行,PR#6504 实测读到 null,那样判「没拉起」是白判)。
    const polls = path.join(home, 'polls')
    const script = keeperScript(home, { adoptPid: sleeper.pid }).replace(/sleep \d+/g, `{ echo . >> '${polls}'; sleep 0.2; }`)
    const keeper = spawn('/bin/sh', ['-c', script], { stdio: 'ignore' })
    const exited = new Promise((resolve) => keeper.on('exit', resolve))
    await awaitFact(
      '看门人对被接手的进程看过两圈',
      () => (fs.existsSync(polls) && fs.readFileSync(polls, 'utf8').length >= 2 ? true : undefined),
      { producer: keeper },
    )
    expect(fs.existsSync(keeperPidFile(home))).toBe(true)
    expect(runs()).toHaveLength(0)
    // 被接手的这个进程是 sh 的孙辈之外的无关进程:看门人只能按 /proc 或 kill -0 看它死没死。
    expect(liveKeeperPid(home, { isAlive: () => true, cmdline: () => `/bin/sh -c ${script}` })).toBe(keeper.pid)
    sleeper.kill('SIGKILL')
    await exited
    expect(runs()).toHaveLength(1)
  })

  it('pid 文件里的进程号被别的程序复用了:不算活着的看门人', () => {
    const { home } = fakeInstall([])
    fs.writeFileSync(path.join(home, 'data', 'keeper.pid'), '4242')
    expect(liveKeeperPid(home, { isAlive: () => true, cmdline: () => 'nginx: worker process' })).toBeNull()
    expect(liveKeeperPid(home, { isAlive: () => false, cmdline: () => null })).toBeNull()
    expect(liveKeeperPid(home, { isAlive: () => true, cmdline: () => null })).toBe(4242)
  })
})

describe('登录 shell', () => {
  const exec = (ok: string[]) => (file: string) => ok.includes(file)

  it('优先用安装时终端里的 $SHELL,其次 passwd,再次进程环境', () => {
    expect(resolveLoginShell({ recorded: '/usr/bin/zsh\n', passwd: '/bin/bash', env: '/bin/sh', isExecutable: exec(['/usr/bin/zsh', '/bin/bash', '/bin/sh']) })).toBe('/usr/bin/zsh')
    expect(resolveLoginShell({ recorded: null, passwd: '/bin/bash', env: '/bin/sh', isExecutable: exec(['/bin/bash', '/bin/sh']) })).toBe('/bin/bash')
    expect(resolveLoginShell({ recorded: null, passwd: null, env: '/bin/sh', isExecutable: exec(['/bin/sh']) })).toBe('/bin/sh')
  })

  it('记下的 shell 已经不在了、passwd 写的是 nologin:都跳过', () => {
    expect(resolveLoginShell({ recorded: '/opt/gone/fish', passwd: '/usr/sbin/nologin', env: '/bin/bash', isExecutable: exec(['/usr/sbin/nologin', '/bin/bash']) })).toBe('/bin/bash')
    expect(resolveLoginShell({ recorded: null, passwd: '/bin/false', env: undefined, isExecutable: () => true })).toBeNull()
  })
})
