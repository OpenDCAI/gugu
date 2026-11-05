import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const script = path.resolve(__dirname, '../../../scripts/flake-check.mjs')
const check = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

describe('flake-check reads .github/flake-registry.json', () => {
  test('a registered file reports its status and the PR that removed the cause', () => {
    const r = check('tests/unit/scripts/devNodeExternals.test.ts')
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('FIXED in #1723')
  })

  test('a file under a registered directory matches the open entry, which still leaves the check red', () => {
    const r = check('apps/desktop/src/session/renderer/tests/browser/input-area-slash-draft.test.tsx')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('OPEN')
    expect(r.stdout).toContain('the check is still red')
  })

  test('an unregistered failure is reported as real', () => {
    const r = check('no such test anywhere')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('Treat the failure as real')
  })
})
