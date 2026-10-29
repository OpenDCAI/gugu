import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeLegacyBrowserLogins } from '../../../../apps/desktop/electron/lib/remove-legacy-browser-logins'

const roots: string[] = []
const log = { info: vi.fn(), warn: vi.fn() }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it('removes saved website logins and interrupted writes while preserving the shared key and other credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-logins-upgrade-'))
  roots.push(root)
  const browser = path.join(root, 'cloud-browser')
  fs.mkdirSync(browser)
  const legacy = ['saved-logins.enc', 'saved-logins.enc.123.tmp']
  for (const name of legacy) fs.writeFileSync(path.join(browser, name), 'legacy ciphertext')
  fs.writeFileSync(path.join(root, 'task-host-secret.key'), 'shared key')
  fs.writeFileSync(path.join(root, 'server-session.enc'), 'machine session')
  fs.writeFileSync(path.join(browser, 'other.enc'), 'keep')

  expect(removeLegacyBrowserLogins(root, log)).toEqual({ removed: 2, failed: 0 })

  for (const name of legacy) expect(fs.existsSync(path.join(browser, name))).toBe(false)
  expect(fs.readFileSync(path.join(root, 'task-host-secret.key'), 'utf8')).toBe('shared key')
  expect(fs.readFileSync(path.join(root, 'server-session.enc'), 'utf8')).toBe('machine session')
  expect(fs.readFileSync(path.join(browser, 'other.enc'), 'utf8')).toBe('keep')
  expect(removeLegacyBrowserLogins(root, log)).toEqual({ removed: 0, failed: 0 })
  expect(log.info).toHaveBeenCalledWith('Browser saved-login migration removed legacy files', expect.objectContaining({ removed: 2 }))
})

it('reports a cleanup failure and retries it at the next startup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-logins-retry-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'cloud-browser'))
  const file = path.join(root, 'cloud-browser', 'saved-logins.enc')
  fs.writeFileSync(file, 'legacy ciphertext')
  const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
  try {
    expect(removeLegacyBrowserLogins(root, log)).toEqual({ removed: 0, failed: 1 })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not remove'), expect.objectContaining({ file }))
    expect(fs.existsSync(file)).toBe(true)
  } finally { unlink.mockRestore() }
  expect(removeLegacyBrowserLogins(root, log)).toEqual({ removed: 1, failed: 0 })
  expect(fs.existsSync(file)).toBe(false)
})
