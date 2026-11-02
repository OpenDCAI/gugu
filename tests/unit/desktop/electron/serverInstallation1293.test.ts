import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveServerHome, installationServerNames, repairLegacyServerLaunchers } from '../../../../apps/desktop/electron/server/server-installation'
import { serverNames } from '../../../../apps/desktop/electron/server/server-names'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture(channel = 'beta') {
  const userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-install-')))
  roots.push(userHome)
  const home = path.join(userHome, '.gugu-server')
  const version = path.join(home, 'versions', '0.3.1-beta.1')
  fs.mkdirSync(path.join(version, 'app'), { recursive: true })
  fs.mkdirSync(path.join(version, 'bin'))
  fs.writeFileSync(path.join(version, 'bin', 'gugu-server'), '#!/bin/sh\nprintf "%s" "$GUGU_SERVER_HOME"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(home, 'channel'), channel)
  fs.symlinkSync(path.relative(home, version), path.join(home, 'current'))
  return { userHome, home, version }
}

describe('legacy server installation identity', () => {
  it('reads the installed home when a Beta package is invoked without an explicit home', () => {
    const { userHome, home, version } = fixture()
    expect(resolveServerHome({ GUGU_TASK_HOST_APP_PATH: path.join(version, 'app') }, userHome, serverNames('beta'))).toBe(home)
    expect(resolveServerHome({ GUGU_SERVER_HOME: '/explicit/home', GUGU_TASK_HOST_APP_PATH: path.join(version, 'app') }, userHome, serverNames('beta'))).toBe('/explicit/home')
  })

  it('keeps new installations channel-specific and does not infer a home from an unpacked directory', () => {
    const { userHome } = fixture()
    expect(resolveServerHome({}, userHome, serverNames('beta'))).toBe(path.join(userHome, '.gugu-server-beta'))
    expect(resolveServerHome({ GUGU_TASK_HOST_APP_PATH: path.join(userHome, 'unpacked', 'app') }, userHome, serverNames('beta'))).toBe(path.join(userHome, '.gugu-server-beta'))
  })

  it('preserves legacy service and tmux names while new Beta services retain their own names', () => {
    const { userHome, home } = fixture()
    expect(installationServerNames(home, serverNames('beta'), userHome)).toEqual(serverNames('stable'))
    expect(installationServerNames(path.join(userHome, '.gugu-server-beta'), serverNames('beta'), userHome)).toEqual(serverNames('beta'))
    fs.writeFileSync(path.join(home, 'channel'), 'stable')
    expect(installationServerNames(home, serverNames('beta'), userHome)).toEqual(serverNames('beta'))
  })

  it('upgrades the old symlink and publishes the Beta command against the SAME account home', () => {
    const { userHome, home } = fixture()
    const bin = path.join(userHome, '.local', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.symlinkSync(path.join(home, 'current', 'bin', 'gugu-server'), path.join(bin, 'gugu-server'))
    fs.mkdirSync(path.join(userHome, '.gugu-server-beta'))
    repairLegacyServerLaunchers(home, serverNames('beta'), userHome)
    for (const name of ['gugu-server', 'gugu-server-beta']) {
      // A wrong home inherited from another channel must not redirect an installed command.
      const result = execFileSync(path.join(bin, name), ['status'], { encoding: 'utf8', env: { ...process.env, GUGU_SERVER_HOME: '/other/channel' } })
      expect(result).toBe(home)
    }
    expect(fs.lstatSync(path.join(bin, 'gugu-server')).isSymbolicLink()).toBe(false)
    expect(fs.realpathSync(path.join(userHome, '.gugu-server-beta'))).toBe(home)
    expect(resolveServerHome({ GUGU_SERVER_HOME: path.join(userHome, '.gugu-server-beta') }, userHome, serverNames('beta'))).toBe(home)
    repairLegacyServerLaunchers(home, serverNames('beta'), userHome)
    expect(execFileSync(path.join(bin, 'gugu-server-beta'), { encoding: 'utf8' })).toBe(home)
  })

  it('preserves user commands and another installation instead of replacing them', () => {
    const { userHome, home } = fixture()
    const bin = path.join(userHome, '.local', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'gugu-server'), '#!/bin/sh\necho custom\n', { mode: 0o755 })
    fs.symlinkSync('/some/other/server', path.join(bin, 'gugu-server-beta'))
    repairLegacyServerLaunchers(home, serverNames('beta'), userHome)
    expect(execFileSync(path.join(bin, 'gugu-server'), { encoding: 'utf8' }).trim()).toBe('custom')
    expect(fs.readlinkSync(path.join(bin, 'gugu-server-beta'))).toBe('/some/other/server')
  })

  it('does not publish a legacy command over a separately installed Beta home', () => {
    const { userHome, home } = fixture()
    const other = path.join(userHome, '.gugu-server-beta')
    fs.mkdirSync(path.join(other, 'versions'), { recursive: true })
    fs.writeFileSync(path.join(other, 'channel'), 'beta')
    repairLegacyServerLaunchers(home, serverNames('beta'), userHome)
    expect(fs.lstatSync(other).isSymbolicLink()).toBe(false)
    expect(fs.existsSync(path.join(userHome, '.local', 'bin', 'gugu-server-beta'))).toBe(false)
  })
})
