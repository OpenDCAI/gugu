// #6264 手动安装 / 重装也清旧版本,与自动升级同一条规则(在用的 + 最近 5 份;各账号可以各跑各的版本)——
// 否则旧版本把系统盘吃满(2026-09-24 d22 的系统盘满到装不下新包)。真跑一遍 install.sh:假包、假 HOME,不起服务、不登录。
// 超过 5 份时清哪些,见 serverMatchingVersions6264.test.ts。
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const INSTALL = path.join(__dirname, '../../../../scripts/gugu-server/install.sh')

function fakePackage(dir: string, version: string): { file: string; sha: string } {
  const root = path.join(dir, `src-${version}`, `gugu-server-${version}`)
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'bin', 'gugu-server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const file = path.join(dir, `pkg-${version}.tar.gz`)
  execFileSync('tar', ['-czf', file, '-C', path.dirname(root), path.basename(root)])
  return { file, sha: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
}

function install(home: string, dir: string, version: string): void {
  const pkg = fakePackage(dir, version)
  execFileSync('sh', [INSTALL, '--package', pkg.file, '--version', version, '--sha256', pkg.sha, '--no-login', '--no-service'], {
    env: { ...process.env, HOME: home, GUGU_SERVER_HOME: path.join(home, '.gugu-server') },
    stdio: 'pipe',
  })
}

describe('install.sh 清旧版本', () => {
  it('连装四个版本:都在「在用的 + 最近 5 份」以内,全留着;current 指向最新的', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-install-prune-'))
    const home = path.join(dir, 'home')
    fs.mkdirSync(home)
    for (const v of ['0.1.1', '0.1.2', '0.1.3', '0.1.4']) install(home, dir, v)
    const versions = path.join(home, '.gugu-server', 'versions')
    expect(fs.readdirSync(versions).filter((n) => !n.startsWith('.')).sort()).toEqual(['0.1.1', '0.1.2', '0.1.3', '0.1.4'])
    expect(fs.readlinkSync(path.join(home, '.gugu-server', 'current'))).toBe('versions/0.1.4')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('重装同一个版本:上一个版本还在最近 5 份里,留着', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-install-prune-'))
    const home = path.join(dir, 'home')
    fs.mkdirSync(home)
    install(home, dir, '0.1.1')
    install(home, dir, '0.1.2')
    install(home, dir, '0.1.2')
    const versions = path.join(home, '.gugu-server', 'versions')
    expect(fs.readdirSync(versions).filter((n) => !n.startsWith('.')).sort()).toEqual(['0.1.1', '0.1.2'])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
