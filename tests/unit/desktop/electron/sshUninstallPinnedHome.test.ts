import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../../../../apps/desktop/electron/server/server-names', async original => ({
  ...await original<typeof import('../../../../apps/desktop/electron/server/server-names')>(),
  desktopServerChannel: () => 'beta',
}))
import { binLauncher } from '../../../../apps/desktop/electron/server/server-names'
import { inspectScript, parseInspectOutput, uninstallScript, UNINSTALLED_MARK } from '../../../../apps/desktop/electron/server/ssh-uninstall'

let home: string
const id = '11111111-1111-4111-8111-111111111111'
afterEach(() => { if (home) fs.rmSync(home, { recursive: true, force: true }) })

function install() {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-pinned-uninstall-'))
  const root = path.join(home, '.gugu-server')
  const version = path.join(root, 'versions', '1136')
  fs.mkdirSync(path.join(version, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(version, 'version'), '1136\n')
  fs.writeFileSync(path.join(version, 'bin/gugu-server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  fs.symlinkSync('versions/1136', path.join(root, 'current'))
  fs.mkdirSync(path.join(root, 'accounts', id, 'data'), { recursive: true })
  fs.writeFileSync(path.join(root, 'accounts', id, 'account.json'), JSON.stringify({ userId: id, email: 'me@example.test' }))
  fs.writeFileSync(path.join(root, 'accounts', id, 'data/server-session.enc'), 'fixture')
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true })
  for (const name of ['gugu-server', 'gugu-server-beta']) fs.writeFileSync(path.join(home, '.local/bin', name), binLauncher(root), { mode: 0o755 })
  return root
}
function run(script: string) {
  const file = path.join(home, 'test.sh')
  fs.writeFileSync(file, script)
  return spawnSync('/bin/sh', [file], { env: { HOME: home, PATH: '/usr/bin:/bin', GUGU_SERVER_HOME: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

it('pinned beta inspection reads the legacy unsuffixed installation', () => {
  install()
  const result = run(inspectScript())
  expect(result.status).toBe(0)
  expect(parseInspectOutput(result.stdout)).toMatchObject({ installed: true, version: '1136', accounts: [{ userId: id, signedIn: true }] })
})
it('pinned uninstall removes the actual home and both owning launchers while preserving other data', () => {
  const root = install()
  const other = path.join(home, '.gugu-server-beta')
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(other, 'unrelated'), 'keep')
  const result = run(uninstallScript())
  expect(result.status).toBe(0)
  expect(result.stdout).toContain(UNINSTALLED_MARK)
  expect(fs.existsSync(root)).toBe(false)
  for (const name of ['gugu-server', 'gugu-server-beta']) expect(fs.existsSync(path.join(home, '.local/bin', name))).toBe(false)
  expect(fs.readFileSync(path.join(other, 'unrelated'), 'utf8')).toBe('keep')
})
it('pinned uninstall cannot report success for an already missing home', () => {
  const root = install()
  fs.rmSync(root, { recursive: true, force: true })
  const result = run(uninstallScript())
  expect(result.status).not.toBe(0)
  expect(result.stdout).not.toContain(UNINSTALLED_MARK)
  expect(result.stderr).toContain(root)
})
