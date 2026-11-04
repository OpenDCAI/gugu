import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))

it.each([250, 5000])('real server startup preserves dual-stack selection with a suitable connection window (initial %i ms)', initial => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-network-startup-'))
  try {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import * as net from 'node:net';
      import { getDefaultResultOrder } from 'node:dns';
      net.setDefaultAutoSelectFamilyAttemptTimeout(${initial});
      const before = { family: net.getDefaultAutoSelectFamily(), dns: getDefaultResultOrder() };
      process.argv = [process.execPath, 'server-entry.ts', '--version'];
      process.on('exit', () => process.stdout.write('NETWORK_STARTUP=' + JSON.stringify({
        timeout: net.getDefaultAutoSelectFamilyAttemptTimeout(),
        family: net.getDefaultAutoSelectFamily(), dns: getDefaultResultOrder(), before,
      }) + '\\n'));
      await import('./apps/desktop/electron/server-entry.ts');
    `], {
      cwd: root, encoding: 'utf8', timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: home, GUGU_HOME: home, GUGU_USER_DATA_DIR: home,
        GUGU_SERVER_HOME: home, GUGU_TIER: 'beta', GUGU_TASK_HOST_VERSION: 'network-startup-test' },
    })
    const reading = JSON.parse(output.split('NETWORK_STARTUP=')[1]!.trim())
    expect(reading.timeout).toBe(Math.max(initial, 2000))
    expect(reading.family).toBe(reading.before.family)
    expect(reading.dns).toBe(reading.before.dns)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
