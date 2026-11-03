import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const scratch = new Set<string>()
afterEach(() => {
  for (const directory of scratch) fs.rmSync(directory, { recursive: true, force: true })
  scratch.clear()
})

function boot(existingData: boolean) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-legacy-cache-test-'))
  scratch.add(directory)
  const binary = path.join(directory, 'gugu-server.mts')
  const record = path.join(directory, 'boot.json')
  const environmentModule = pathToFileURL(path.resolve('apps/desktop/electron/server/server-package-environment.mts')).href
  fs.writeFileSync(binary, `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
// Rosetta creates this before Node executes the server's modules.
fs.mkdirSync(path.join(process.env.HOME, '.cache/rosetta'), { recursive: true });
const { prepareInstallation } = await import(${JSON.stringify(environmentModule)});
const home = process.env.GUGU_SERVER_HOME;
const data = process.env.GUGU_TASK_HOST_USER_DATA;
const accountFile = path.join(data, 'original-account-data');
if (${existingData}) fs.writeFileSync(accountFile, 'existing account bytes');
const row = { home, userHome: process.env.HOME, pid: process.pid, before: fs.readdirSync(home) };
try {
  prepareInstallation(home, { schema: 1, backendUrl: 'https://fixture.example.test', channel: 'beta' });
} catch (error) {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ ...row, error: error.message,
    accountBytes: fs.existsSync(accountFile) ? fs.readFileSync(accountFile, 'utf8') : null, installation: fs.existsSync(path.join(home, 'installation.json')) }));
  throw error;
}
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(row));
process.on('SIGTERM', () => process.exit(143));
fs.writeFileSync(path.join(data, 'activity.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now(), at: Date.now() }));
setInterval(() => {}, 1000);
`, { mode: 0o700 })
  const result = spawnSync(process.execPath, [path.resolve('scripts/gugu-server/smoke-legacy-account.mts'), binary], {
    env: process.env, encoding: 'utf8', timeout: 10_000,
  })
  const row = JSON.parse(fs.readFileSync(record, 'utf8')) as {
    home: string; userHome: string; pid: number; before: string[]; error?: string; accountBytes?: string; installation?: boolean
  }
  return { result, row }
}

describe.runIf(process.platform !== 'win32')('legacy account boot runtime cache isolation', () => {
  it('keeps OS runtime caches outside the never-used installation and removes both homes', () => {
    const { result, row } = boot(false)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`legacy boot ready: pid=${row.pid}`)
    expect(row.before).toEqual(['accounts'])
    expect(row.userHome).not.toBe(row.home)
    expect(path.dirname(row.userHome)).toBe(path.dirname(row.home))
    expect(fs.existsSync(path.dirname(row.home))).toBe(false)
    expect(() => process.kill(row.pid, 0)).toThrow()
  })

  it('still rejects real unverified account data without changing its bytes or creating installation evidence', () => {
    const { result, row } = boot(true)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Existing account environment cannot be verified; explicit migration is required')
    expect(row).toMatchObject({ accountBytes: 'existing account bytes', installation: false })
    expect(fs.existsSync(path.dirname(row.home))).toBe(false)
    expect(() => process.kill(row.pid, 0)).toThrow()
  })
})
