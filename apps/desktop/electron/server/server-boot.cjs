// Shipped verbatim. The launcher loads this before parsing any application module.
const fs = require('node:fs')
const path = require('node:path')

const file = (home, name) => path.join(home, 'data', name)
const readJson = name => JSON.parse(fs.readFileSync(name, 'utf8'))
const version = value => typeof value === 'string' && /^[0-9A-Za-z._-]{1,64}$/.test(value) && !value.startsWith('.')
function writeJson(name, value) {
  fs.mkdirSync(path.dirname(name), { recursive: true })
  const temporary = `${name}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  fs.renameSync(temporary, name)
}
const accountId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
function accountIdentity(directory, fallback) {
  let meta
  try { meta = readJson(path.join(directory, 'account.json')) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Could not read ${directory}/account.json: ${error.message}`) }
  const id = meta?.userId ?? fallback
  if (!accountId(id)) throw new Error(`Account identity is missing or invalid: ${directory}/account.json`)
  if (fallback && id !== fallback) throw new Error(`Account identity does not match its directory: ${directory}`)
  return { dir: directory, id, email: typeof meta?.email === 'string' ? meta.email : null,
    addedAt: typeof meta?.addedAt === 'string' ? meta.addedAt : null,
    signedIn: fs.existsSync(path.join(directory, 'data/server-session.enc')) }
}
function readCurrentAccount(home) {
  const directory = path.join(home, 'account')
  try {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Expected an account directory: ${directory}`)
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  return accountIdentity(directory)
}
function realAccountDirectories(home) {
  const candidates = []
  const current = readCurrentAccount(home)
  if (current) candidates.push(current)
  const legacy = path.join(home, 'accounts')
  let entries
  try {
    if (!fs.lstatSync(legacy).isDirectory()) throw new Error(`Expected an account directory: ${legacy}`)
    entries = fs.readdirSync(legacy, { withFileTypes: true })
  }
  catch (error) { if (error.code === 'ENOENT') return candidates; throw error }
  for (const entry of entries) {
    if (!entry.name.startsWith('.') && entry.isDirectory()) candidates.push(accountIdentity(path.join(legacy, entry.name), entry.name))
  }
  return candidates
}
const shellQuote = value => `'${value.replace(/'/g, `'"'"'`)}'`
function moveAccount(account, destination) {
  const meta = path.join(account.dir, 'account.json')
  let value = {}
  try { value = readJson(meta) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!value.userId) writeJson(meta, { ...value, userId: account.id })
  fs.renameSync(account.dir, destination)
}
function retireAccount(home, account) {
  const destination = path.join(home, 'retired', account.id)
  if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite retained account data: ${destination}`)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  moveAccount(account, destination)
}
function syncAccountAlias(home, id) {
  const legacy = path.join(home, 'accounts')
  if (!id && !fs.existsSync(legacy)) return
  fs.mkdirSync(legacy, { recursive: true })
  for (const entry of fs.readdirSync(legacy, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue
    const name = path.join(legacy, entry.name)
    // Only aliases owned by this transition may be removed.
    if (path.resolve(legacy, fs.readlinkSync(name)) === path.join(home, 'account') && entry.name !== id) fs.unlinkSync(name)
  }
  if (!id) return
  const alias = path.join(legacy, id)
  try {
    const stat = fs.lstatSync(alias)
    if (!stat.isSymbolicLink()) throw new Error(`Refusing to replace account data: ${alias}`)
    if (fs.readlinkSync(alias) === '../account') return
    fs.unlinkSync(alias)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  fs.symlinkSync('../account', alias)
}
function migrateAccountLayout(home) {
  const candidates = realAccountDirectories(home)
  const signedIn = candidates.filter(account => account.signedIn)
  if (signedIn.length > 1) {
    const commands = signedIn.map(account => `${account.email ?? account.id}:\n  mkdir -p ${shellQuote(path.join(home, 'retired'))} && mv -n ${shellQuote(account.dir)} ${shellQuote(path.join(home, 'retired', account.id))}`)
    throw new Error(`More than one account is signed in. No account data was changed. Keep one account and move the others, then restart:\n${commands.join('\n')}`)
  }
  const current = path.join(home, 'account')
  const selected = signedIn[0] ?? candidates.find(account => account.dir === current)
  const retired = candidates.filter(account => account !== selected)
  // Detect collisions before the first rename; retained history is never overwritten.
  const destinations = new Set()
  for (const account of retired) {
    const destination = path.join(home, 'retired', account.id)
    if (destinations.has(destination) || fs.existsSync(destination)) throw new Error(`Refusing to overwrite retained account data: ${destination}`)
    destinations.add(destination)
  }
  for (const account of retired) retireAccount(home, account)
  if (selected && selected.dir !== current) moveAccount(selected, current)
  syncAccountAlias(home, selected?.id)
}
function prepareAccountLogin(home, id) {
  if (!accountId(id)) throw new Error('Invalid account identity')
  const current = path.join(home, 'account')
  if (realAccountDirectories(home).some(account => account.dir !== current)) throw new Error('Legacy account data must be migrated by gugu-server start before login.')
  const previous = readCurrentAccount(home)
  if (previous?.signedIn && previous.id !== id) throw new Error(`Gugu server is signed in as ${previous.email ?? previous.id}. Sign out first.`)
  if (previous?.id !== id) {
    if (previous) retireAccount(home, previous)
    const retained = path.join(home, 'retired', id)
    if (fs.existsSync(retained)) {
      moveAccount(accountIdentity(retained, id), current)
    }
    else {
      fs.mkdirSync(current, { recursive: true })
      writeJson(path.join(current, 'account.json'), { userId: id })
    }
  }
  syncAccountAlias(home, id)
}
function pointCurrent(home, directory) {
  const versions = fs.realpathSync(path.join(home, 'versions'))
  const target = fs.realpathSync(directory)
  if (path.dirname(target) !== versions) throw new Error('Version is outside the managed versions directory')
  const temporary = path.join(home, `current.boot-${process.pid}`)
  fs.rmSync(temporary, { force: true })
  fs.symlinkSync(path.relative(home, target), temporary)
  fs.renameSync(temporary, path.join(home, 'current'))
}
function live(pid) {
  try { process.kill(pid, 0) } catch (error) { return error.code !== 'ESRCH' }
  if (process.platform !== 'linux') return true
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    if (/^[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 2))) return false
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('server.js')
  } catch { return true }
}
function bootId() {
  if (process.platform !== 'linux') return process.env.GUGU_SERVER_BOOT_ID?.trim() || null
  try {
    const id = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    if (!id) throw new Error('empty boot identity')
    return id
  }
  catch (error) {
    process.stderr.write(`[server] Could not read boot identity (${error.code || error.message}); retaining locks conservatively.\n`)
    return null
  }
}
const proofFile = (home, stat) => file(home, `.server-lock-${stat.dev}-${stat.ino}.json`)
function lockInfo(home, name = file(home, 'server.lock')) {
  const fd = fs.openSync(name, 'r')
  try {
    const stat = fs.fstatSync(fd)
    const pid = Number(fs.readFileSync(fd, 'utf8').trim())
    let proof
    try { proof = readJson(proofFile(home, stat)) } catch { /* Released locks have no boot proof. */ }
    return { pid, stat, proof }
  } finally { fs.closeSync(fd) }
}
function lockLive(info, alive) {
  const id = bootId()
  if (id && info.proof?.pid === info.pid && typeof info.proof.bootId === 'string' && info.proof.bootId && info.proof.bootId !== id) return false
  return alive(info.pid)
}
function homeLockHolder(home, alive = live) {
  try {
    const info = lockInfo(home)
    return Number.isSafeInteger(info.pid) && info.pid > 0 && lockLive(info, alive) ? info.pid : null
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
function removeLock(home, name) {
  let stat
  try { stat = fs.lstatSync(name) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  fs.rmSync(name, { force: true })
  if (stat.nlink === 1) fs.rmSync(proofFile(home, stat), { force: true })
}
function ownsHomeLock(home) {
  try { return Number(fs.readFileSync(file(home, 'server.lock'), 'utf8')) === process.pid }
  catch (error) {
    if (error.code === 'ENOENT') return false
    process.stderr.write(`[server] Could not verify installation lock (${error.code || error.message}); retaining this process and checking again.\n`)
    return undefined
  }
}
function waitForPreviousPid() {
  const pid = Number(process.env.GUGU_SERVER_WAIT_PID)
  delete process.env.GUGU_SERVER_WAIT_PID
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return
  const deadline = Date.now() + 60_000
  process.stderr.write(`[server] Waiting for previous server (pid ${pid}) before acquiring the installation lock.\n`)
  const pause = new Int32Array(new SharedArrayBuffer(4))
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') return }
    Atomics.wait(pause, 0, 0, 100)
  }
  process.stderr.write('[server] Previous server wait expired; checking installation lock normally.\n')
}
function claimHomeLock(home) {
  const lock = file(home, 'server.lock')
  let owned
  try { owned = lockInfo(home) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (owned.pid !== process.pid) return null
  return () => {
    try {
      const current = lockInfo(home)
      if (current.pid === process.pid && current.stat.ino === owned.stat.ino && current.stat.dev === owned.stat.dev) removeLock(home, lock)
    } catch { /* Already released. */ }
  }
}
function acquireHomeLock(home, alive = live) {
  const lock = file(home, 'server.lock')
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  // A settled duplicate must not create temporary files or change the live data directory's mtime.
  try {
    const current = lockInfo(home)
    if (!Number.isSafeInteger(current.pid) || current.pid <= 0 || lockLive(current, alive)) return null
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const acquire = () => {
    const candidate = `${lock}.candidate-${process.pid}-${process.hrtime.bigint()}`
    const fd = fs.openSync(candidate, 'wx', 0o600)
    const proof = proofFile(home, fs.fstatSync(fd))
    try {
      fs.writeFileSync(fd, String(process.pid))
      writeJson(proof, { pid: process.pid, bootId: bootId() })
      try { fs.linkSync(candidate, lock); return true }
      catch (error) { if (error.code === 'EEXIST') return false; throw error }
    } finally {
      fs.closeSync(fd)
      removeLock(home, candidate)
      fs.rmSync(`${proof}.${process.pid}.tmp`, { force: true })
    }
  }
  if (!acquire()) {
    const original = lockInfo(home)
    const holder = original.pid
    // Invalid/empty content can belong to a writer between open(wx) and its PID write.
    if (!Number.isSafeInteger(holder) || holder <= 0 || lockLive(original, alive)) return null
    const stale = `${lock}.stale-${process.pid}-${Date.now()}`
    try { fs.renameSync(lock, stale) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
    try {
      const moved = lockInfo(home, stale)
      if (moved.pid !== holder || moved.stat.ino !== original.stat.ino || moved.stat.dev !== original.stat.dev) {
        // Another starter replaced the stale lock. Restore it without overwriting any newer owner.
        try { fs.linkSync(stale, lock) } catch (error) { if (error.code !== 'EEXIST') throw error }
        return null
      }
      if (!acquire()) return null
    } finally { removeLock(home, stale) }
  }
  return claimHomeLock(home)
}
function validatePending(value) {
  if (!value || !version(value.from) || !version(value.to) || !Number.isSafeInteger(value.attempts)
    || value.attempts < 0 || (value.request !== undefined && !Number.isFinite(value.request))) {
    throw new Error('Invalid pending server verification record')
  }
  return value
}
function readPendingVerify(home) {
  const pending = file(home, 'pending-verify.json')
  if (!fs.existsSync(pending)) return null
  try { return validatePending(readJson(pending)) }
  catch (error) {
    const evidence = `${pending}.invalid-${Date.now()}-${process.pid}`
    process.stderr.write(`[server] INVALID STARTUP VERIFICATION: ${error.message}; retaining ${evidence}; continuing current package.\n`)
    try { fs.renameSync(pending, evidence) }
    catch (renameError) { process.stderr.write(`[server] Could not retain invalid verification record: ${renameError.message}\n`) }
    return null
  }
}
function writePendingVerify(home, value) { writeJson(file(home, 'pending-verify.json'), validatePending(value)) }
function markServerReady(home, now = Date.now()) {
  const pending = readPendingVerify(home)
  if (!pending || process.env.GUGU_TASK_HOST_VERSION !== pending.to) return
  writeJson(file(home, 'server-update.json'), { state: 'idle', version: pending.to, previous: pending.from, at: now,
    lastOutcome: { kind: 'switched', target: pending.to, at: now,
      ...(pending.request !== undefined ? { request: pending.request } : {}) } })
  fs.rmSync(file(home, 'pending-verify.json'), { force: true })
}
function readBadVersions(home) {
  let raw
  try { raw = readJson(file(home, 'bad-versions.json')) } catch { return {} }
  const out = {}
  for (const [name, at] of Object.entries(raw || {})) if (version(name) && typeof at === 'number' && Number.isFinite(at)) out[name] = at
  return out
}
function legacyGuardActive(home) {
  if (!fs.existsSync(file(home, 'upgrade-pending.json'))) return false
  let pid
  try { pid = Number(readJson(file(home, 'upgrade-guard.pid'))) } catch { return false }
  if (!Number.isSafeInteger(pid) || pid <= 0 || !live(pid)) return false
  if (process.platform === 'linux') {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes('upgrade-guard') }
    catch { return true }
  }
  // As with the home lock, platforms without /proc conservatively respect a live PID.
  return true
}
function checkPendingBoot(home) {
  if (legacyGuardActive(home)) {
    process.stderr.write('[server] The deployed legacy upgrade guard owns this transition; launch-count rollback is deferred.\n')
    return false
  }
  const pending = readPendingVerify(home)
  if (!pending || process.env.GUGU_TASK_HOST_VERSION !== pending.to) return false
  writePendingVerify(home, { ...pending, attempts: pending.attempts + 1 })
  if (pending.attempts < 3) return false
  const versions = fs.realpathSync(path.join(home, 'versions'))
  const previous = fs.realpathSync(path.join(versions, pending.from))
  if (path.dirname(previous) !== versions) throw new Error('Rollback package is outside this installation')
  const badFile = file(home, 'bad-versions.json')
  const bad = fs.existsSync(badFile) ? readJson(badFile) : {}
  if (!bad || typeof bad !== 'object' || Array.isArray(bad)) throw new Error('Invalid bad versions record')
  pointCurrent(home, previous)
  const at = Date.now()
  writeJson(badFile, { ...bad, [pending.to]: at })
  writeJson(file(home, 'server-update.json'), { state: 'idle', version: pending.from, at,
    lastOutcome: { kind: 'rolledBack', bad: pending.to, back: pending.from, at,
      ...(pending.request !== undefined ? { request: pending.request } : {}) } })
  fs.rmSync(file(home, 'pending-verify.json'))
  return true
}

module.exports = { acquireHomeLock, claimHomeLock, ownsHomeLock, homeLockHolder, readPendingVerify, writePendingVerify, markServerReady, writeJson, pointCurrent, readBadVersions, legacyGuardActive, migrateAccountLayout, prepareAccountLogin, readCurrentAccount }

// Importing these same helpers from a bundle never counts another attempt.
if (process.argv[2] === 'run' && process.execArgv.some((arg, i) => arg === '--require' && process.execArgv[i + 1] === __filename)) {
  const home = process.env.GUGU_SERVER_HOME
  let release
  try {
    waitForPreviousPid()
    release = acquireHomeLock(home)
    if (!release) {
      const empty = fs.readFileSync(file(home, 'server.lock'), 'utf8').trim() === ''
      process.stderr.write(empty
        ? '[server] Installation lock file is empty. Confirm that no server is running, then remove data/server.lock and start again.\n'
        : '[server] Installation lock is held; refusing a duplicate start.\n')
      process.exit(78)
    }
    process.on('exit', release)
    migrateAccountLayout(home)
    if (checkPendingBoot(home)) process.exit(75)
  } catch (error) {
    process.stderr.write(`[server] Startup verification failed: ${error.message}\n`)
    if (release && process.env.GUGU_SERVER_SUPERVISED !== 'systemd') {
      try { fs.writeFileSync(file(home, 'stopped'), '') } catch { /* Preserve configuration exit 78. */ }
    }
    process.exit(78)
  }
}
