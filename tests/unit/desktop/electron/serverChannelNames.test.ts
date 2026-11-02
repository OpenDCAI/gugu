// 各通道的咕咕 server 在同一个用户下各占一套名字(server-names.ts、install.sh)。
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { binLauncher, remoteServerPaths, serverNames } from '../../../../apps/desktop/electron/server/server-names'
import { guguLinkScheme, tierSuffix } from '../../../../packages/core/src/shared/ui/guguLink'

const INSTALL_SH = path.resolve(__dirname, '../../../../scripts/gugu-server/install.sh')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function tmp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-channel-'))
  roots.push(root)
  return root
}

describe('serverNames:正式版不带后缀,其余通道加 -<通道>', () => {
  it('与桌面 ~/.gugu / ~/.gugu-<tier> 同一条规则', () => {
    expect(serverNames('stable')).toEqual({
      homeDir: '.gugu-server',
      bin: 'gugu-server',
      systemdUnit: 'gugu-server.service',
      launchdLabel: 'space.nextmind.gugu-server',
      cronMark: '# gugu-server',
    })
    expect(serverNames('beta')).toEqual({
      homeDir: '.gugu-server-beta',
      bin: 'gugu-server-beta',
      systemdUnit: 'gugu-server-beta.service',
      launchdLabel: 'space.nextmind.gugu-server-beta',
      cronMark: '# gugu-server-beta',
    })
  })

  it('桌面经 SSH 拼的路径按桌面自己的通道', () => {
    expect(remoteServerPaths('stable')).toEqual({
      home: '"${GUGU_SERVER_HOME:-$HOME/.gugu-server}"',
      bin: '"$HOME/.local/bin/gugu-server"',
      binTilde: '~/.local/bin/gugu-server',
    })
    expect(remoteServerPaths('beta').binTilde).toBe('~/.local/bin/gugu-server-beta')
  })

  it('tier 名与通道名走同一条规则(tierSuffix):production 与 stable 都不带后缀', () => {
    expect(serverNames('production')).toEqual(serverNames('stable'))
    expect(tierSuffix('production')).toBe('')
    expect(tierSuffix('stable')).toBe('')
    expect(tierSuffix('beta')).toBe('-beta')
    expect(guguLinkScheme({ tier: 'beta', devLaunch: false })).toBe('gugu-beta')
    expect(guguLinkScheme({ tier: undefined, devLaunch: false })).toBe('gugu')
  })
})

/** 一个假包(--package 模式,不上网):bin/gugu-server 打出它收到的 GUGU_SERVER_HOME。 */
function fakePackage(root: string, version: string): { file: string; sha256: string } {
  const stage = path.join(root, 'stage', `gugu-server-${version}`)
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(stage, 'bin', 'gugu-server'), '#!/bin/sh\necho "home=$GUGU_SERVER_HOME"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(stage, 'version'), version)
  const file = path.join(root, `gugu-server-${version}.tar.gz`)
  execFileSync('tar', ['-czf', file, '-C', path.dirname(stage), path.basename(stage)])
  return { file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
}

function install(home: string, channel: string, pkg: { file: string; sha256: string }, version: string) {
  return spawnSync(
    'sh',
    [INSTALL_SH, '--channel', channel, '--package', pkg.file, '--version', version, '--sha256', pkg.sha256, '--no-service', '--no-login'],
    { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' },
  )
}

describe('install.sh 按通道装', () => {
  it('同一个用户先装 Beta 再装正式版:两套目录、两条命令,互不覆盖', () => {
    const root = tmp()
    const home = path.join(root, 'home')
    fs.mkdirSync(home)
    const beta = install(home, 'beta', fakePackage(root, '0.4.0-beta.1.1'), '0.4.0-beta.1.1')
    expect(beta.status, beta.stderr).toBe(0)
    const stable = install(home, 'stable', fakePackage(root, '0.4.0'), '0.4.0')
    expect(stable.status, stable.stderr).toBe(0)

    for (const [channel, version] of [['beta', '0.4.0-beta.1.1'], ['stable', '0.4.0']] as const) {
      const names = serverNames(channel)
      const serverHome = path.join(home, names.homeDir)
      expect(fs.readFileSync(path.join(serverHome, 'channel'), 'utf8').trim()).toBe(channel)
      expect(fs.readFileSync(path.join(serverHome, 'current', 'version'), 'utf8')).toBe(version)
      const bin = path.join(home, '.local', 'bin', names.bin)
      // 与 server-names.ts 写的是同一份启动脚本;别的通道的 server 拉起的环境里带着它自己的 GUGU_SERVER_HOME,照样钉回本通道。
      expect(fs.readFileSync(bin, 'utf8')).toBe(binLauncher(serverHome))
      const ran = spawnSync(bin, [], { env: { PATH: process.env.PATH, GUGU_SERVER_HOME: '/elsewhere' }, encoding: 'utf8' })
      expect(ran.stdout.trim()).toBe(`home=${serverHome}`)
    }
  })

  it('已经装着正式版:Beta 装进自己的名字下,正式版那份不碰', () => {
    const root = tmp()
    const home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, '.gugu-server'), { recursive: true })
    fs.writeFileSync(path.join(home, '.gugu-server', 'channel'), 'stable\n')
    const run = install(home, 'beta', fakePackage(root, '0.4.0-beta.3.1'), '0.4.0-beta.3.1')
    expect(run.status, run.stderr).toBe(0)
    expect(fs.readFileSync(path.join(home, '.gugu-server-beta', 'current', 'version'), 'utf8')).toBe('0.4.0-beta.3.1')
    expect(fs.readFileSync(path.join(home, '.gugu-server', 'channel'), 'utf8').trim()).toBe('stable')
  })
})
