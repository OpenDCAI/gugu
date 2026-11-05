import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { existingIdentityScript, parseExistingIdentity } from '../../../../apps/desktop/electron/server/ssh-install/existing-account'
import { formatStatusJson } from '../../../../apps/desktop/electron/server/server-status'

const id = 'a'.repeat(32)
const account = { userId: 'user-a', email: 'alice@example.test', signedIn: true, signedOut: null, running: true }

function readFileValue(value: string | Buffer) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-1642-full-id-'))
  try {
    const installation = path.join(home, 'preserved server')
    fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true })
    fs.mkdirSync(path.join(installation, 'current/bin'), { recursive: true })
    fs.writeFileSync(path.join(installation, 'install-id'), value)
    fs.writeFileSync(path.join(home, '.local/bin/gugu-server'), `#!/bin/sh\nGUGU_SERVER_HOME="${installation}" exec "${installation}/current/bin/gugu-server" "$@"\n`, { mode: 0o755 })
    const report = formatStatusJson({ version: '1149', accounts: [account] })
    fs.writeFileSync(path.join(installation, 'current/bin/gugu-server'), `#!/bin/sh\n[ "$1" = status ] || exit 73\nprintf '%s\\n' '${report}'\n`, { mode: 0o755 })
    const scriptFile = path.join(home, 'identity.sh')
    fs.writeFileSync(scriptFile, existingIdentityScript())
    return spawnSync('sh', [scriptFile], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

describe('#1642 complete installation identity file', () => {
  it.each([
    { name: 'valid prefix followed by another line', raw: `${id}\nnot-part-of-the-id` },
    { name: 'two valid ID lines', raw: `${id}\n${id}` },
    { name: 'CRLF followed by suffix data', raw: `${id}\r\nother-data` },
    { name: 'trailing non-whitespace', raw: `${id}suffix` },
    { name: 'internal whitespace', raw: `${id.slice(0, 16)} ${id.slice(16)}` },
    { name: 'embedded NUL', raw: Buffer.from(`${id}\0`) },
    { name: 'empty file', raw: '' },
    { name: 'only whitespace', raw: '\r\n \t\n' },
  ])('rejects the whole file: $name', ({ raw }) => {
    const result = readFileValue(raw)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('identity is empty or invalid')
    expect(result.stdout).not.toContain('machine_id=')
    expect(() => parseExistingIdentity(result.stdout, account.userId)).toThrow()
  })

  it.each([
    { name: 'no final newline', raw: id },
    { name: 'LF', raw: `${id}\n` },
    { name: 'CRLF', raw: `${id}\r\n` },
    { name: 'outer whitespace as trimmed by the server', raw: ` \t\r\n${id} \t\r\n` },
  ])('uses the complete trimmed server value: $name', ({ raw }) => {
    const result = readFileValue(raw)
    expect(result.status).toBe(0)
    expect(parseExistingIdentity(result.stdout, account.userId).machineId).toBe(raw.trim())
  })

  it('emits only one canonical identity line after validating the complete file', () => {
    const result = readFileValue(`${id}\r\n`)
    expect(result.stdout.match(/^machine_id=.*$/gm)).toEqual([`machine_id=${id}`])
  })
})
