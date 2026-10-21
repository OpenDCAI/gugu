import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function parseArgs(argv) {
  const options = { command: argv[0] === '--help' || argv[0] === '-h' ? 'publish' : (argv[0] ?? 'publish') }
  if (argv[0] === '--help' || argv[0] === '-h') options.help = true
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--session') options.session = argv[++i]
    else if (arg === '--tag') options.tag = argv[++i]
    else if (arg === '--store') options.store = argv[++i]
    else if (arg === '--remote') options.remote = argv[++i]
    else if (arg === '--skip-build') options.skipBuild = true
    else if (arg === '--allow-dirty') options.allowDirty = true
    else if (arg === '--app-version') options.appVersion = argv[++i]
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

function usage() {
  return `Usage: node scripts/e2e-artifact-store.mjs publish [options]

Build and archive an installable macOS package with a visible build tag.

Options:
  --session <id>       Spex session id (required; GUGU_SPEX_SESSION_ID also accepted)
  --tag <value>        Explicit tag (default: e2e-<commit10>-<session8>)
  --store <path>       Local artifact git repository (absolute path)
  --remote <host:path> Mac1 SSH target (for example mac1:/Users/mac1/gugu-e2e-artifacts)
  --skip-build         Archive an already-built release directory
  --allow-dirty        Permit a dirty checkout; manifest records dirty=true
  --app-version <v>    Version baked into the package when the build stamped one as a build
                       parameter (default: the checkout's package.json version)
`
}

// The version a build bakes may be a build parameter rather than the checkout's package.json
// (beta-dogfood.yml stamps `<base>-beta.<run>.<attempt>` and restores the file before archiving, so the
// checkout stays clean and the ledger still names the shipped version). Same shape electron-builder accepts.
function requireAppVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid --app-version ${JSON.stringify(version)} (expected x.y.z or x.y.z-prerelease)`)
  }
  return version
}

function artifactDirectoryName({ appVersion, commit, session }) {
  return `${appVersion}-${commit.slice(0, 10)}-${session.slice(0, 8)}`
}

// An explicit --app-version is not taken on trust: electron-builder names the installer
// `<prefix>-<version>-<arch>.<ext>` from the version it actually baked, so the ledger version must appear
// in at least one installer name or the ledger would describe a different package than it stores.
function assertAppVersionInArtifacts(files, appVersion) {
  const names = files.map((path) => basename(path))
  if (!names.some((name) => /\.(dmg|zip)$/.test(name) && name.includes(`-${appVersion}-`))) {
    throw new Error(`--app-version ${appVersion} does not appear in any installer name (${names.join(', ')}) — the build baked a different version`)
  }
  return appVersion
}

function requireSafeTag(tag) {
  if (!tag || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(tag)) {
    throw new Error(`invalid build tag ${JSON.stringify(tag)} (use letters, digits, ., _, -; max 96 chars)`)
  }
  return tag
}

function sourceState() {
  const commit = git(['rev-parse', 'HEAD'])
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`git HEAD is not a full commit SHA: ${commit}`)
  const dirty = git(['status', '--porcelain=v1', '--untracked-files=all']).length > 0
  const provenancePath = join(root, 'dist', 'gugu-build-provenance.json')
  let fingerprint = null
  if (existsSync(provenancePath)) {
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'))
    fingerprint = provenance.source?.fingerprint ?? null
  }
  if (!fingerprint) throw new Error('dist/gugu-build-provenance.json is missing a source fingerprint; run pnpm build:app first')
  return { commit, dirty, fingerprint }
}

function releaseFiles() {
  const releaseDir = join(root, 'release')
  if (!existsSync(releaseDir)) throw new Error(`release directory is missing: ${releaseDir}`)
  const files = readdirSync(releaseDir)
    .filter((name) => /^gugu-.+\.(dmg|blockmap|zip)$/.test(name))
    .map((name) => join(releaseDir, name))
    .filter((path) => statSync(path).isFile())
  const dmg = files.find((path) => path.endsWith('.dmg'))
  if (!dmg) throw new Error(`no macOS installer found in ${releaseDir}`)
  return files
}

function assertProvenanceTag(tag) {
  const provenance = JSON.parse(readFileSync(join(root, 'dist', 'gugu-build-provenance.json'), 'utf8'))
  if (provenance.buildTag !== tag) {
    throw new Error(`build tag mismatch: provenance has ${JSON.stringify(provenance.buildTag)}, requested ${JSON.stringify(tag)}`)
  }
}

function manifestFor({ state, tag, session, files, appVersion = packageJson.version }) {
  const provenance = JSON.parse(readFileSync(join(root, 'dist', 'gugu-build-provenance.json'), 'utf8'))
  const dbUrl = process.env.GUGU_SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
  let dbHost = null
  try { dbHost = dbUrl ? new URL(dbUrl).host : null } catch { throw new Error(`invalid Supabase URL in build environment: ${dbUrl}`) }
  return {
    schema: 1,
    tag,
    session,
    source: state,
    appVersion,
    platform: `${process.platform}-${process.arch}`,
    supabaseHost: dbHost,
    provenance,
    files: files.map((path) => ({ name: basename(path), size: statSync(path).size, sha256: sha256(path) })),
    // Commit time keeps a rerun of the same immutable source/tag byte-identical.
    createdAt: git(['show', '-s', '--format=%cI', state.commit]),
  }
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function stageArtifact({ state, tag, session, files, appVersion = packageJson.version }) {
  const stage = mkdtempSync(join(tmpdir(), 'gugu-e2e-artifact-'))
  const manifest = manifestFor({ state, tag, session, files, appVersion })
  const directory = artifactDirectoryName({ appVersion, commit: state.commit, session })
  mkdirSync(join(stage, directory))
  for (const file of files) copyFileSync(file, join(stage, directory, basename(file)))
  writeFileSync(join(stage, directory, 'MANIFEST.json'), canonical(manifest), { flag: 'wx', mode: 0o600 })
  return { stage, directory, manifest }
}

// @@@lock-by-holder (#4357) — 等锁不计时:持有者还在发布就一直等,它总会释放。
// 收回只走一条路:锁陈旧(mtime 超过 STORE_LOCK_STALE_MS)且持有者已死或在别的主机。
// ❌ 别改成「同机持有者一死就立刻收回」:两个等待者会同时判死、先后删锁,删掉的是对方刚建的新锁。
// 真卡住由调用方(workflow job)的上限收场,stderr 上那行 step= 指着持有者。
const STORE_LOCK_STALE_MS = 10 * 60 * 1000

function sleepMs(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function acquireStoreLock(store) {
  const lockPath = join(store, '.publish.lock')
  const token = randomUUID()
  let attempt = 0
  let reportedHolder
  for (;;) {
    try {
      writeFileSync(lockPath, `${JSON.stringify({ token, pid: process.pid, host: hostname(), createdAt: new Date().toISOString() })}\n`, {
        flag: 'wx',
        mode: 0o600,
      })
      return () => {
        try {
          const owner = JSON.parse(readFileSync(lockPath, 'utf8'))
          if (owner.token === token) rmSync(lockPath, { force: true })
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let reclaim = false
      let holder = 'unreadable lock'
      try {
        const stat = statSync(lockPath)
        const stale = Date.now() - stat.mtimeMs > STORE_LOCK_STALE_MS
        let owner
        try {
          owner = JSON.parse(readFileSync(lockPath, 'utf8'))
          holder = `pid ${owner.pid} on ${owner.host ?? hostname()}`
        } catch {
          owner = undefined
        }
        if (stale) {
          const sameHost = owner && (!owner.host || owner.host === hostname())
          reclaim = !owner || !sameHost || !processIsAlive(owner.pid)
        }
      } catch (readError) {
        if (readError?.code === 'ENOENT') continue
        reclaim = false
      }
      if (reclaim) {
        try { rmSync(lockPath, { force: true }) } catch (removeError) {
          if (removeError?.code !== 'ENOENT') throw removeError
        }
        continue
      }
      if (reportedHolder !== holder) {
        process.stderr.write(`[e2e-artifact-store] step=wait-for-store-lock ${lockPath} (held by ${holder})\n`)
        reportedHolder = holder
      }
      sleepMs(Math.min(100 + attempt * 50, 500))
      attempt += 1
    }
  }
}

function githubRunKey(session) {
  return /^github-actions-/.test(session) ? session.replace(/-\d+$/, '') : session
}

function sameGithubRun(existing, incoming) {
  return typeof existing?.session === 'string'
    && typeof incoming?.session === 'string'
    && githubRunKey(existing.session) === githubRunKey(incoming.session)
}

function publishLocalUnlocked({ store, staged, directory }) {
  if (!store || !store.startsWith('/')) throw new Error('--store must be an absolute path')
  mkdirSync(join(store, 'artifacts'), { recursive: true, mode: 0o700 })
  execFileSync('git', ['init', '-q'], { cwd: store })
  const destination = join(store, 'artifacts', directory)
  const manifestBytes = readFileSync(join(staged, directory, 'MANIFEST.json'), 'utf8')
  if (existsSync(destination)) {
    const existingPath = join(destination, 'MANIFEST.json')
    if (!existsSync(existingPath)) throw new Error(`artifact directory exists but has no manifest: ${destination}`)
    const existingBytes = readFileSync(existingPath, 'utf8')
    let tracked = true
    try { execFileSync('git', ['ls-files', '--error-unmatch', '--', `artifacts/${directory}`], { cwd: store, stdio: 'ignore' }) } catch { tracked = false }
    if (existingBytes === manifestBytes) {
      if (tracked) return destination
      rmSync(destination, { recursive: true, force: true })
    }
    let existingManifest = null
    try { existingManifest = JSON.parse(existingBytes) } catch { existingManifest = null }
    const incomingManifest = JSON.parse(manifestBytes)
    if (existingBytes !== manifestBytes && (tracked || !sameGithubRun(existingManifest, incomingManifest))) {
      throw new Error(`refusing to overwrite conflicting artifact ledger: ${existingPath}`)
    }
    if (existingBytes !== manifestBytes) rmSync(destination, { recursive: true, force: true })
  }
  // Same shape as publishRemote: land the bytes in a dot-prefixed staging dir on the same volume, then
  // one rename. A cancelled job / dead runner / ENOSPC mid-copy leaves at most an `.incoming-*` dir that
  // readers skip, never a half entry with a valid MANIFEST.json beside a truncated installer.
  const incoming = join(store, 'artifacts', `.incoming-${directory}-${process.pid}`)
  rmSync(incoming, { recursive: true, force: true })
  mkdirSync(incoming, { recursive: false, mode: 0o700 })
  try {
    for (const name of readdirSync(join(staged, directory))) {
      copyFileSync(join(staged, directory, name), join(incoming, name), constants.COPYFILE_EXCL)
    }
    renameSync(incoming, destination)
  } catch (error) {
    rmSync(incoming, { recursive: true, force: true })
    throw error
  }
  execFileSync('git', ['add', '--', `artifacts/${directory}`], { cwd: store })
  execFileSync('git', ['-c', 'user.name=gugu-e2e', '-c', 'user.email=gugu-e2e@localhost', 'commit', '-m', `e2e artifact ${directory}`, '--quiet'], { cwd: store })
  return destination
}

function publishLocal({ store, staged, directory, lockHeld = false }) {
  if (!store || !store.startsWith('/')) throw new Error('--store must be an absolute path')
  mkdirSync(store, { recursive: true, mode: 0o700 })
  if (lockHeld) return publishLocalUnlocked({ store, staged, directory })
  const release = acquireStoreLock(store)
  try { return publishLocalUnlocked({ store, staged, directory }) } finally { release() }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function remoteParts(remote) {
  const match = /^(?:([^:]+):)?(\/[^:]+)$/.exec(remote ?? '')
  if (!match) throw new Error(`--remote must look like host:/absolute/path, got ${JSON.stringify(remote)}`)
  if (!/^[A-Za-z0-9._-]+$/.test(match[1] ?? 'mac1')) throw new Error(`unsafe SSH host: ${match[1]}`)
  if (!/^[A-Za-z0-9._/+-]+$/.test(match[2])) throw new Error(`unsafe remote path: ${match[2]}`)
  return { host: match[1] ?? 'mac1', path: match[2] }
}

function sshArgs() {
  const config = process.env.GUGU_SSH_CONFIG || join(homedir(), 'YellowPage', 'ssh_config')
  return existsSync(config) ? ['-F', config] : []
}

function publishRemote({ remote, staged, directory }) {
  const { host, path: repo } = remoteParts(remote)
  const target = `${repo}/artifacts/${directory}`
  const incoming = `${repo}/.incoming-${directory}-${process.pid}`
  const ssh = (command) => execFileSync('ssh', [...sshArgs(), host, command], { stdio: 'inherit' })
  const sshRead = (command) => execFileSync('ssh', [...sshArgs(), host, command], { encoding: 'utf8' }).trim()
  ssh(`mkdir -p ${shellQuote(`${repo}/artifacts`)}`)
  let existingManifest = null
  try {
    existingManifest = sshRead(`cat ${shellQuote(`${target}/MANIFEST.json`)}`)
  } catch {
    existingManifest = null
  }
  if (existingManifest !== null) {
    const expected = readFileSync(join(staged, directory, 'MANIFEST.json'), 'utf8').trim()
    if (existingManifest !== expected) throw new Error(`remote artifact already exists with a conflicting manifest: ${target}`)
    return target
  }
  ssh(`mkdir ${shellQuote(incoming)}`)
  const names = readdirSync(join(staged, directory))
  for (const name of names) execFileSync('scp', [...sshArgs(), join(staged, directory, name), `${host}:${incoming}/${name}`], { stdio: 'inherit' })
  for (const name of names) {
    const expected = sha256(join(staged, directory, name))
    const actual = execFileSync('ssh', [...sshArgs(), host, `shasum -a 256 ${shellQuote(`${incoming}/${name}`)} | awk '{print $1}'`], { encoding: 'utf8' }).trim()
    if (actual !== expected) throw new Error(`remote sha256 mismatch for ${name}: expected ${expected}, got ${actual}`)
  }
  ssh(`mv ${shellQuote(incoming)} ${shellQuote(target)} && git -C ${shellQuote(repo)} init -q && git -C ${shellQuote(repo)} add ${shellQuote(`artifacts/${directory}`)} && git -C ${shellQuote(repo)} -c user.name=gugu-e2e -c user.email=gugu-e2e@localhost commit -m ${shellQuote(`e2e artifact ${directory}`)} -q`)
  return target
}

function run() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) return process.stdout.write(usage())
  if (options.command !== 'publish') throw new Error(`unknown command ${options.command}; use publish`)
  const session = options.session || process.env.GUGU_SPEX_SESSION_ID
  if (!session || !/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(session)) throw new Error('Spex session id is required (--session or GUGU_SPEX_SESSION_ID)')
  const stateBefore = sourceState()
  if (stateBefore.dirty && !options.allowDirty) throw new Error('refusing to package a dirty checkout; use --allow-dirty to record +dirty explicitly')
  const tag = requireSafeTag(options.tag || `e2e-${stateBefore.commit.slice(0, 10)}-${session.slice(0, 8)}`)
  const appVersion = options.appVersion === undefined ? packageJson.version : requireAppVersion(options.appVersion)
  if (!options.skipBuild) {
    execFileSync('pnpm', ['build:beta'], { cwd: root, stdio: 'inherit', env: { ...process.env, GUGU_BUILD_TAG: tag } })
  }
  assertProvenanceTag(tag)
  const state = sourceState()
  if (state.commit !== stateBefore.commit) throw new Error(`build changed HEAD from ${stateBefore.commit} to ${state.commit}`)
  const files = releaseFiles()
  if (options.appVersion !== undefined) assertAppVersionInArtifacts(files, appVersion)
  const store = options.store || process.env.GUGU_E2E_ARTIFACT_STORE || join(root, '.e2e-artifacts')
  if (!options.remote && !store.startsWith('/')) throw new Error('--store must be an absolute path')
  const release = options.remote ? null : acquireStoreLock(store)
  try {
    const staged = stageArtifact({ state, tag, session, files, appVersion })
    try {
      const destination = options.remote
        ? publishRemote({ remote: options.remote, staged: staged.stage, directory: staged.directory })
        : publishLocal({ store, staged: join(staged.stage), directory: staged.directory, lockHeld: true })
      process.stdout.write(`[e2e-artifact] published ${staged.directory}\n[e2e-artifact] destination=${destination}\n[e2e-artifact] tag=${tag} session=${session} commit=${state.commit}\n`)
    } finally {
      rmSync(staged.stage, { recursive: true, force: true })
    }
  } finally {
    release?.()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { run() } catch (error) { console.error(`[e2e-artifact] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 }
}

export { artifactDirectoryName, assertAppVersionInArtifacts, manifestFor, parseArgs, publishLocal, requireAppVersion, requireSafeTag, sha256, stageArtifact }
