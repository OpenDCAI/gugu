/*
 * #6264「server 和桌面版本不匹配时，当场换成匹配的版本，升降都算」(product spec 第 5 条例外,owner 2026-09-25):
 *  · 不同账号共用一台机器:各跑和自己桌面匹配的那一份,换版只重启那一个账号;
 *  · 同一账号两台桌面版本不同:按新的那一边跑(选 A);
 *  · 降级:桌面比装着的旧 ⇒ 装旧版并只切这个账号;
 *  · 换版装东西的只有那台机器上的守护进程:桌面经 SSH 只报版本、请它换、上不了网时传字节(❌ 再装一份);
 *  · 超出兼容窗口:旧桌面那一侧显示「请更新这台电脑上的咕咕」(不去降同账号更新桌面在用的那一版);
 *  · 清理:在用的 + 最近 5 份。
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compareServerVersions,
  desktopProtocolOutsideWindow,
  parseDesktopHello,
} from '../../../../packages/core/src/cloud/serverDesktopVersions'
import { parseServerUpdateState } from '../../../../packages/core/src/cloud/deviceHostInfo'
import { normalizeDeviceCapabilities } from '../../../../packages/core/src/cloud/devices'
import { fetchVersionManifest, VersionNotPublishedError } from '../../../../apps/desktop/electron/server/server-updater'
import { MIN_CLIENT_PROTOCOL, REMOTE_PROTOCOL_VERSION } from '../../../../packages/core/src/cloud/serverMachineHealth'
import { pruneVersions, versionsToKeep } from '../../../../apps/desktop/electron/server/server-account-versions'

const U1 = '11111111-1111-4111-8111-111111111111'
const NOW = 1_800_000_000_000

let home = ''
const previousHome = process.env.GUGU_SERVER_HOME

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-match-'))
  process.env.GUGU_SERVER_HOME = home
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.GUGU_SERVER_HOME
  else process.env.GUGU_SERVER_HOME = previousHome
})

const dataDir = (userId: string) => path.join(home, 'accounts', userId, 'data')
function signIn(userId: string): void {
  fs.mkdirSync(dataDir(userId), { recursive: true })
  fs.writeFileSync(path.join(dataDir(userId), 'server-session.enc'), 'x')
}
function installVersion(version: string, mtimeMs = NOW): void {
  const bin = path.join(home, 'versions', version, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'gugu-server'), '#!/bin/sh\n')
  fs.utimesSync(path.join(home, 'versions', version), mtimeMs / 1000, mtimeMs / 1000)
}
describe('server version and released protocol parsing', () => {
  it('版本号逐段比,正式版比同号的预发版新', () => {
    expect(compareServerVersions('0.2.50', '0.2.49')).toBeGreaterThan(0)
    expect(compareServerVersions('0.3.0', '0.2.999')).toBeGreaterThan(0)
    expect(compareServerVersions('0.3.0', '0.3.0-beta.9')).toBeGreaterThan(0)
    expect(compareServerVersions('0.3.0-beta.10', '0.3.0-beta.9')).toBeGreaterThan(0)
    // 守护进程自升级也用这把尺(server-updater.ts):以前只比主版本,ThinkPad 停在 46.1 时看不见 48.1。
    expect(compareServerVersions('0.2.51-beta.48.1', '0.2.51-beta.46.1')).toBeGreaterThan(0)
    expect(compareServerVersions('0.2.160', '0.2.160')).toBe(0)
  })

  it('兼容窗口 = [MIN_CLIENT_PROTOCOL, REMOTE_PROTOCOL_VERSION];不报协议的老桌面不下结论', () => {
    expect(desktopProtocolOutsideWindow(REMOTE_PROTOCOL_VERSION)).toBe(false)
    expect(desktopProtocolOutsideWindow(MIN_CLIENT_PROTOCOL)).toBe(false)
    expect(desktopProtocolOutsideWindow(REMOTE_PROTOCOL_VERSION + 1)).toBe(true)
    expect(desktopProtocolOutsideWindow(MIN_CLIENT_PROTOCOL - 1)).toBe(true)
    expect(desktopProtocolOutsideWindow(null)).toBe(false)
  })

  it('桌面开窗口报的那一段:形状不对就不收', () => {
    expect(parseDesktopHello({ id: 'dev-1', version: '0.2.160', protocol: 2 })).toEqual({ id: 'dev-1', version: '0.2.160', protocol: 2 })
    expect(parseDesktopHello({ id: 'dev 1', version: '0.2.160' })).toBeNull()
    expect(parseDesktopHello({ id: 'dev-1', version: '../x' })).toBeNull()
    expect(parseDesktopHello({ id: 'dev-1', version: '0.2.160', protocol: 'x' })).toEqual({ id: 'dev-1', version: '0.2.160', protocol: null })
  })

})

describe('reclamation uses explicit ownership only', () => {
  it('keeps explicitly protected versions without additional mtime guesses', () => {
    const installed = ['0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7', '.download-x'].map((name, i) => ({ name, mtimeMs: i }))
    const keep = versionsToKeep({ installed, inUse: ['0.1.0'] })
    expect([...keep].sort()).toEqual(['0.1.0'])
  })

  it('pruneVersions:账号记着的旧版本不删,下载中的临时目录不碰', () => {
    for (let i = 0; i < 9; i++) installVersion(`0.1.${i}`, NOW + i * 1000)
    fs.mkdirSync(path.join(home, 'versions', '.download-abc'))
    signIn(U1)
    const removed = pruneVersions(path.join(home, 'versions'), ['0.1.0', '0.1.8'])
    expect(removed.sort()).toEqual(['0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7'])
    expect(fs.readdirSync(path.join(home, 'versions')).sort()).toEqual(['.download-abc', '0.1.0', '0.1.8'])
  })

  it('bootstrap installer leaves reclamation to the supervisor', () => {
    const INSTALL = path.join(__dirname, '../../../../scripts/gugu-server/install.sh')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-install-keep-'))
    const userHome = path.join(dir, 'home')
    const serverHome = path.join(userHome, '.gugu-server')
    fs.mkdirSync(userHome)
    const install = (version: string, extra: string[] = [], verification = true) => {
      const root = path.join(dir, `src-${version}`, `gugu-server-${version}`)
      fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
      fs.writeFileSync(path.join(root, 'bin', 'gugu-server'), verification ? '#!/bin/sh\n[ "$1" = help ] && echo prepare-install\nexit 0\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const file = path.join(dir, `pkg-${version}.tar.gz`)
      execFileSync('tar', ['-czf', file, '-C', path.dirname(root), path.basename(root)])
      const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      execFileSync('sh', [INSTALL, '--package', file, '--version', version, '--sha256', sha, '--no-login', '--no-service', ...extra], {
        env: { ...process.env, HOME: userHome, GUGU_SERVER_HOME: serverHome },
        stdio: 'pipe',
      })
      // 目录时刻按装的先后错开(同一秒里装完,ls -t 分不出先后)。
      const t = NOW / 1000 + Number(version.split('.')[2]) * 10
      fs.utimesSync(path.join(serverHome, 'versions', version), t, t)
    }
    install('0.1.1')
    fs.mkdirSync(path.join(serverHome, 'accounts', U1, 'data'), { recursive: true })
    fs.writeFileSync(path.join(serverHome, 'accounts', U1, 'data', 'server-version.json'), JSON.stringify({ version: '0.1.1', previous: null, at: NOW }))
    for (const v of ['0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7', '0.1.8', '0.1.9']) install(v)
    const versions = fs.readdirSync(path.join(serverHome, 'versions')).filter((n) => !n.startsWith('.')).sort()
    // Bootstrap never guesses live versions; only the supervisor reclaims with actual ownership facts.
    expect(versions).toEqual(['0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7', '0.1.8', '0.1.9'])
    expect(fs.readlinkSync(path.join(serverHome, 'current'))).toBe('versions/0.1.9')
    // --keep-current:只装不切。
    install('0.1.0', ['--keep-current'])
    expect(fs.existsSync(path.join(serverHome, 'versions', '.prepared', '0.1.0'))).toBe(true)
    expect(fs.readlinkSync(path.join(serverHome, 'current'))).toBe('versions/0.1.9')
    expect(fs.existsSync(path.join(serverHome, 'versions', '0.1.0', 'bin', 'gugu-server'))).toBe(true)
    // A historical target is inspected by the current verifier, rather than trusted because an unknown command exits zero.
    install('0.1.10', ['--keep-current'], false)
    fs.writeFileSync(path.join(serverHome, 'versions', '0.1.9', 'bin', 'gugu-server'), '#!/bin/sh\nexit 0\n')
    expect(() => install('0.1.11', [], false)).toThrow()
    expect(fs.readlinkSync(path.join(serverHome, 'current'))).toBe('versions/0.1.9')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('「更新没成功」随心跳报到设备行', () => {
  it('failed 状态认得、按时过期;设备行解析时保留', () => {
    expect(parseServerUpdateState(JSON.stringify({ state: 'failed', version: '0.2.9', at: NOW }), NOW + 1000)).toEqual({ state: 'failed', version: '0.2.9' })
    expect(parseServerUpdateState(JSON.stringify({ state: 'failed', version: '0.2.9', at: NOW }), NOW + 11 * 60_000)).toBeNull()
    expect(normalizeDeviceCapabilities({ host_kind: 'server', server_update: { state: 'failed', version: '0.2.9' } }).server_update).toEqual({ state: 'failed', version: '0.2.9' })
  })
})

// The download-site manifest backfill script and its case belong to the official release tooling, not this repository.
describe('测试下载站补「钉在这一版上的清单」', () => {
  it('fetchVersionManifest:先读钉在这一版上的清单;没有时通道清单正好是这一版也认;都不是就说没有', async () => {
    fs.writeFileSync(path.join(home, 'channel'), 'stable\n')
    const prev = process.env.GUGU_SERVER_DOWNLOAD_BASE
    process.env.GUGU_SERVER_DOWNLOAD_BASE = 'http://cdn'
    const sha = 'a'.repeat(64)
    const files: Record<string, string> = {}
    const fetchFile = async (url: string) => (url in files ? new Response(files[url]) : new Response('', { status: 404 }))
    const key = (dir: string) => Object.keys(files).find((k) => k.includes(`/${dir}/`))
    files[`http://cdn/stable/${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.txt`] = `0.2.161 ${sha} http://cdn/x.tgz`
    expect((await fetchVersionManifest(home, '0.2.161', fetchFile)).version).toBe('0.2.161')
    // 通道已经越过要的这一版:永远不会有,是真失败。
    await expect(fetchVersionManifest(home, '0.2.150', fetchFile)).rejects.toThrow('没有 0.2.150')
    await expect(fetchVersionManifest(home, '0.2.150', fetchFile)).rejects.not.toThrow(VersionNotPublishedError)
    // 通道还停在更旧的版本:还没发。
    await expect(fetchVersionManifest(home, '0.2.170', fetchFile)).rejects.toThrow(VersionNotPublishedError)
    // 通道也 404(下载站 / 前缀配错):真失败。
    const nothing = async () => new Response('', { status: 404 })
    await expect(fetchVersionManifest(home, '0.2.170', nothing)).rejects.toThrow('没有 0.2.170')
    await expect(fetchVersionManifest(home, '0.2.170', nothing)).rejects.not.toThrow(VersionNotPublishedError)
    // 下载站出错 / 连不上照旧是失败。
    const down = async () => new Response('', { status: 500 })
    await expect(fetchVersionManifest(home, '0.2.150', down)).rejects.toThrow('没有 0.2.150')
    await expect(fetchVersionManifest(home, '0.2.150', down)).rejects.not.toThrow(VersionNotPublishedError)
    const offline = async (): Promise<Response> => { throw new Error('ECONNREFUSED') }
    await expect(fetchVersionManifest(home, '0.2.150', offline)).rejects.not.toThrow(VersionNotPublishedError)
    const pinned = key('stable')!.replace('/stable/', '/0.2.150/')
    files[pinned] = `0.2.150 ${sha} http://cdn/y.tgz`
    expect((await fetchVersionManifest(home, '0.2.150', fetchFile)).url).toBe('http://cdn/y.tgz')
    if (prev === undefined) delete process.env.GUGU_SERVER_DOWNLOAD_BASE
    else process.env.GUGU_SERVER_DOWNLOAD_BASE = prev
  })
})
