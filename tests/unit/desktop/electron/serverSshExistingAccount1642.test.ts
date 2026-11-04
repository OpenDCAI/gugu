import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatStatusJson } from '../../../../apps/desktop/electron/server/server-status'
import { REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import { InstallRun, runSshInstall, type SshInstallDeps } from '../../../../apps/desktop/electron/server/ssh-install/runner'
import { PROBE_BEGIN, PROBE_END } from '../../../../apps/desktop/electron/server/ssh-install/logic'
import { EXISTING_IDENTITY_BEGIN, EXISTING_IDENTITY_END, existingIdentityScript, parseExistingIdentity, safeSshText } from '../../../../apps/desktop/electron/server/ssh-install/existing-account'
import { cloudExistingDevice } from '../../../../apps/desktop/electron/server/ssh-install/existing-device'

const machineId = 'a'.repeat(32)
const account = { userId: 'user-a', email: 'alice@example.test', signedIn: true, signedOut: null, running: true }
const status = (accounts = [account], migrationRequired = false) => formatStatusJson({ version: '1149', supervisorVersion: '1149', accounts, migrationRequired })
const identity = (accounts = [account], id: string | null = machineId) => `${EXISTING_IDENTITY_BEGIN}\n${status(accounts)}\n${id === null ? 'identity_missing=1' : `machine_id=${id}`}\n${EXISTING_IDENTITY_END}\n`

function fixture(options: { accounts?: typeof account[]; id?: string | null; statusOutput?: string; identityCode?: number; identityErrorOutput?: string; running?: boolean } = {}) {
  const seen: string[] = []
  const mintGrant = vi.fn(async () => ({ deviceCode: 'device-code-not-to-consume' }))
  const existingDevice = vi.fn(async () => 'device-a')
  const rememberExistingDevice = vi.fn(async () => undefined)
  let readIdentity = () => identity(options.accounts, options.id)
  const deps: SshInstallDeps = {
    mintGrant, existingDevice, rememberExistingDevice, currentUserId: async () => 'user-a',
    desktopDownload: vi.fn(), controlPath: null, downloadBase: 'https://download.invalid', customDownloadBase: false,
    channel: 'stable', signal: new AbortController().signal,
    spawnSsh: async (_args, { stdin, onStdout, onStderr }) => {
      const script = String(stdin)
      seen.push(script)
      let stdout: string
      if (script.includes(PROBE_BEGIN)) stdout = `${PROBE_BEGIN}\nos=Linux\narch=x86_64\nuser=linux-user\nhostname=box\nlibc=glibc 2.35\ninstalled=1149\ngrant=1\nprotocol=${REMOTE_PROTOCOL_VERSION}\nstatus_exit=0\n${options.statusOutput ?? status((options.accounts ?? [account]).map(a => ({ ...a, running: options.running ?? a.running })))}\n${PROBE_END}\n`
      else if (script.includes(EXISTING_IDENTITY_BEGIN)) {
        stdout = options.identityErrorOutput ?? readIdentity()
        onStdout?.(stdout.slice(0, 70)); onStdout?.(stdout.slice(70))
        return { code: options.identityCode ?? 0, stdout, stderr: options.identityCode && !options.identityErrorOutput ? 'Permission denied' : '' }
      } else if (script.includes('service install')) stdout = 'service started\n'
      else if (script.includes('login --grant-stdin')) {
        return { code: 1, stdout: 'This server is already signed in as alice@example.test. Run gugu-server logout first.', stderr: '' }
      } else throw new Error(`Unexpected SSH command: ${script}`)
      onStdout?.(stdout); onStderr?.('Authenticated to box using publickey.\n')
      return { code: 0, stdout, stderr: '' }
    },
  }
  const run = new InstallRun('test', 'linux-user@box', () => undefined)
  return { deps, seen, mintGrant, existingDevice, rememberExistingDevice, run,
    identity: (value: () => string) => { readIdentity = value },
    start: () => runSshInstall({ destination: 'linux-user@box', display: 'linux-user@box' }, run, deps) }
}

afterEach(() => vi.unstubAllEnvs())

describe('#1642 existing account attachment', () => {
  it('keeps the existing login and claims a released server without a new capability', async () => {
    const f = fixture()
    const final = await f.start()
    expect(final.failure).toBeNull()
    expect(final.result).toMatchObject({ userId: account.userId, deviceId: 'device-a', alreadySignedIn: true })
    expect(f.mintGrant).not.toHaveBeenCalled()
    expect(f.seen.some(script => /login --grant|logout|service install|--no-login/.test(script))).toBe(false)
    expect(f.rememberExistingDevice).toHaveBeenCalledExactlyOnceWith('device-a', account.userId)
    expect(final.steps.find(step => step.id === 'login')).toMatchObject({ status: 'skipped', skippedBecause: 'alreadySignedIn' })
    expect(JSON.stringify(final)).not.toContain(account.email)
  })

  it('names a different account without exposing its email or changing the installation', async () => {
    const f = fixture({ accounts: [{ ...account, userId: 'user-b' }] })
    const final = await f.start()
    expect(final.failure?.detail).toContain('a… · user-b')
    expect(final.result).toBeNull()
    expect(f.seen).toHaveLength(1)
    expect(JSON.stringify(final)).not.toContain(account.email)
    expect(f.mintGrant).not.toHaveBeenCalled()
  })

  it.each([null, ''])('fails explicitly for a missing or empty installation ID (%s)', async id => {
    const f = fixture({ id })
    const final = await f.start()
    expect(final.failure?.detail).toMatch(id === null ? /Update the server/ : /empty or invalid/)
    expect(f.existingDevice).not.toHaveBeenCalled()
    expect(f.mintGrant).not.toHaveBeenCalled()
    expect(f.rememberExistingDevice).not.toHaveBeenCalled()
  })

  it.each(['{broken', ''])('does not treat an unreadable account query as an empty account', async statusOutput => {
    const f = fixture({ statusOutput })
    expect((await f.start()).failure?.detail).toContain('Could not determine')
    expect(f.mintGrant).not.toHaveBeenCalled()
  })

  it('preserves a real SSH query error instead of requesting a new login', async () => {
    const f = fixture({ identityCode: 1 })
    expect((await f.start()).failure?.detail).toContain('Permission denied')
    expect(f.mintGrant).not.toHaveBeenCalled()
  })

  it('preserves a failed status command explanation written on stdout', async () => {
    const f = fixture({ identityCode: 1, identityErrorOutput: 'Could not read account metadata: IO failure' })
    expect((await f.start()).failure?.detail).toContain('Could not read account metadata: IO failure')
    expect(f.mintGrant).not.toHaveBeenCalled()
  })

  it('rejects an empty existing device ID', async () => {
    const f = fixture(); f.existingDevice.mockResolvedValue('')
    expect((await f.start()).failure?.detail).toContain('device ID is empty or invalid')
    expect(f.rememberExistingDevice).not.toHaveBeenCalled()
  })

  it.each(['cloud error', 'mapping error'])('reports %s without a successful result', async kind => {
    const f = fixture()
    if (kind === 'cloud error') f.existingDevice.mockRejectedValue(new Error('RLS denied'))
    else f.rememberExistingDevice.mockRejectedValue(new Error('Disk full'))
    const final = await f.start()
    expect(final.failure?.detail).toContain(kind === 'cloud error' ? 'RLS denied' : 'Disk full')
    expect(final.result).toBeNull()
    expect(f.mintGrant).not.toHaveBeenCalled()
  })

  it('starts a stopped same-account service without logging it in again', async () => {
    const f = fixture({ running: false })
    // The supervisor is absent while the account is stopped.
    f.deps.spawnSsh = new Proxy(f.deps.spawnSsh, { apply: async (call, self, args) => {
      const result = await Reflect.apply(call, self, args)
      return String(args[1].stdin).includes(PROBE_BEGIN) ? { ...result, stdout: result.stdout.replace(/"supervisorVersion":"1149"/, '"supervisorVersion":null') } : result
    } })
    expect((await f.start()).failure).toBeNull()
    expect(f.seen.filter(s => s.includes('service install'))).toHaveLength(1)
    expect(f.mintGrant).not.toHaveBeenCalled()
  })

  it.each(['desktop', 'remote', 'installation', 'cancelled'])('rejects a late result after %s changes', async change => {
    const f = fixture()
    const controller = new AbortController(); f.deps.signal = controller.signal
    f.existingDevice.mockImplementation(async () => {
      if (change === 'desktop') f.deps.currentUserId = async () => 'user-b'
      if (change === 'remote') f.identity(() => identity([{ ...account, userId: 'user-b' }]))
      if (change === 'installation') f.identity(() => identity([account], 'b'.repeat(32)))
      if (change === 'cancelled') controller.abort()
      return 'device-a'
    })
    const final = await f.start()
    expect(final.failure).not.toBeNull()
    expect(final.result).toBeNull()
    expect(f.rememberExistingDevice).not.toHaveBeenCalled()
    expect(f.mintGrant).not.toHaveBeenCalled()
  })

  it('does not hide a desktop authentication query error', async () => {
    const f = fixture(); f.deps.currentUserId = async () => { throw new Error('Authentication unavailable') }
    expect((await f.start()).failure?.detail).toBe('Authentication unavailable')
    expect(f.mintGrant).not.toHaveBeenCalled()
  })

  it('compares user IDs even when the email changes', async () => {
    const f = fixture(); f.identity(() => identity([{ ...account, email: 'new@example.test' }]))
    expect((await f.start()).failure).toBeNull()
  })
})

describe('#1642 exact cloud identity lookup', () => {
  const auth = { userId: account.userId, accessToken: 'opaque-test-token' }
  const row = { device_id: 'device-a', user_id: account.userId, machine_id: machineId, tier: 'beta' }
  function lookup(body: unknown, httpStatus = 200) {
    vi.stubEnv('GUGU_SUPABASE_URL', 'https://db.invalid'); vi.stubEnv('GUGU_SUPABASE_ANON_KEY', 'public-fixture')
    const getAuth = vi.fn(async () => auth)
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: httpStatus, headers: { 'content-type': 'application/json' } }))
    return { getAuth, request, read: cloudExistingDevice(getAuth, 'beta', request) }
  }

  it('uses the actual PostgREST client with explicit owner, installation and tier filters', async () => {
    const f = lookup([row])
    expect(await f.read({ userId: auth.userId, machineId, signal: new AbortController().signal })).toBe('device-a')
    const url = new URL(String(f.request.mock.calls[0][0]))
    expect(url.searchParams.get('user_id')).toBe(`eq.${auth.userId}`)
    expect(url.searchParams.get('machine_id')).toBe(`eq.${machineId}`)
    expect(url.searchParams.get('tier')).toBe('eq.beta')
    expect(url.searchParams.get('limit')).toBe('2')
    expect(f.request).toHaveBeenCalledTimes(1)
  })

  it.each([[], [row, row], [{ ...row, device_id: '' }], [{ ...row, user_id: 'user-b' }], [{ ...row, tier: 'production' }], [{ ...row, machine_id: 'different' }]].map(rows => ({ rows })))('rejects missing, ambiguous or mismatched rows %#', async ({ rows }) => {
    const f = lookup(rows)
    await expect(f.read({ userId: auth.userId, machineId, signal: new AbortController().signal })).rejects.toThrow()
    expect(f.request).toHaveBeenCalledTimes(1)
  })

  it('keeps the cloud denial and redacts the actual token from its detail', async () => {
    const f = lookup({ message: `RLS denied ${auth.accessToken}` }, 403)
    await expect(f.read({ userId: auth.userId, machineId, signal: new AbortController().signal })).rejects.toThrow('RLS denied [REDACTED]')
  })

  it('rejects a changed desktop owner after the response', async () => {
    const f = lookup([row]); f.getAuth.mockResolvedValueOnce(auth).mockResolvedValue({ ...auth, userId: 'user-b' })
    await expect(f.read({ userId: auth.userId, machineId, signal: new AbortController().signal })).rejects.toThrow('account changed')
  })
})

describe('#1642 identity and display boundaries', () => {
  it('reads the selected launcher home without evaluating it or reading session credentials', () => {
    const script = existingIdentityScript()
    expect(script).toContain('sed -n'); expect(script).toContain('"$H/install-id"')
    expect(script).not.toMatch(/server-session|account\.json|eval |source /)
  })

  it('rejects a migration instead of adopting a legacy account', () => {
    expect(() => parseExistingIdentity(identity().replace(status(), status([account], true)), account.userId)).toThrow('migration')
  })

  it('keeps secrets and complete email addresses out of visible text', () => {
    const text = safeSshText('alice@example.test access_token=opaque-secret refresh_token=another-secret device_code=device-secret token_hash=hash-secret')
    expect(text).not.toContain('alice@example.test'); expect(text).not.toContain('opaque-secret'); expect(text).not.toContain('another-secret')
    expect(text).not.toContain('device-secret'); expect(text).not.toContain('hash-secret')
  })

  it('executes the identity read against a released-style launcher and its pinned installation', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-1642-identity-'))
    try {
      const installation = path.join(home, 'preserved server')
      fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true })
      fs.mkdirSync(path.join(installation, 'current/bin'), { recursive: true })
      fs.writeFileSync(path.join(installation, 'install-id'), `${machineId}\n`)
      fs.writeFileSync(path.join(home, '.local/bin/gugu-server'), `#!/bin/sh\nGUGU_SERVER_HOME="${installation}" exec "${installation}/current/bin/gugu-server" "$@"\n`, { mode: 0o755 })
      fs.writeFileSync(path.join(installation, 'current/bin/gugu-server'), `#!/bin/sh\n[ "$1" = status ] || exit 73\nprintf '%s\\n' '${status()}'\n`, { mode: 0o755 })
      const scriptFile = path.join(home, 'read-identity.sh')
      fs.writeFileSync(scriptFile, existingIdentityScript())
      const output = execFileSync('sh', [scriptFile], { env: { ...process.env, HOME: home, GUGU_SERVER_HOME: path.join(home, 'wrong-home') }, encoding: 'utf8' })
      expect(parseExistingIdentity(output, account.userId)).toEqual({ machineId, email: account.email })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
