/** One installation keeps its backend across every package transition. No account credentials are read here. */
import fs from 'node:fs'
import path from 'node:path'

export type ServerPackageIdentity = { schema: 1; backendUrl: string; channel: string }
export type ServerInstallation = ServerPackageIdentity & { updateOwner: 'controller' | 'server' }
export const SERVER_PACKAGE_IDENTITY = 'server-build.json'
export const SERVER_INSTALLATION = 'installation.json'

export function backendIdentity(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid server backend identity')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export function packageIdentity(value: unknown): ServerPackageIdentity {
  const identity = value as Partial<ServerPackageIdentity> | null
  if (identity?.schema !== 1 || typeof identity.backendUrl !== 'string' || typeof identity.channel !== 'string'
    || !/^[a-z][a-z0-9-]*$/.test(identity.channel)) throw new Error('Server package has no valid environment identity')
  return { schema: 1, backendUrl: backendIdentity(identity.backendUrl), channel: identity.channel }
}

declare const __GUGU_DEFAULT_SUPABASE_URL__: string | undefined
declare const __GUGU_SERVER_CHANNEL__: string | undefined
export function ownPackageIdentity(): ServerPackageIdentity {
  return packageIdentity({ schema: 1,
    backendUrl: typeof __GUGU_DEFAULT_SUPABASE_URL__ === 'string' ? __GUGU_DEFAULT_SUPABASE_URL__ : undefined,
    channel: typeof __GUGU_SERVER_CHANNEL__ === 'string' ? __GUGU_SERVER_CHANNEL__ : undefined })
}

/** Older packages already contain Vite's compiled backend metadata. Inspect it without executing the package. */
export function packageBackend(directory: string): string {
  const dist = path.join(directory, 'app', 'dist-electron')
  const metadata = path.join(dist, SERVER_PACKAGE_IDENTITY)
  if (fs.existsSync(metadata)) return packageIdentity(JSON.parse(fs.readFileSync(metadata, 'utf8'))).backendUrl
  const urls = new Set<string>()
  for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const source = fs.readFileSync(path.join(dist, entry.name), 'utf8')
    for (const match of source.matchAll(/\b(?:const|let|var)\s+__vite_import_meta_env__\s*=\s*(\{.*?\});/gs)) {
      const value = JSON.parse(match[1]) as { VITE_SUPABASE_URL?: unknown }
      if (value.VITE_SUPABASE_URL !== undefined) {
        if (typeof value.VITE_SUPABASE_URL !== 'string') throw new Error('Invalid compiled backend metadata')
        urls.add(backendIdentity(value.VITE_SUPABASE_URL))
      }
    }
  }
  if (urls.size !== 1) throw new Error('Legacy server backend cannot be verified; explicit migration is required')
  return [...urls][0]
}

export function readInstallation(home: string): ServerInstallation | null {
  const file = path.join(home, SERVER_INSTALLATION)
  if (!fs.existsSync(file)) return null
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ServerInstallation>
  if (value.updateOwner !== 'controller' && value.updateOwner !== 'server') throw new Error('Invalid server update owner')
  return { ...packageIdentity(value), updateOwner: value.updateOwner }
}

function sameBackend(expected: string, actual: string): void {
  if (expected !== actual) throw new Error('Server package belongs to another backend; the existing installation was preserved')
}

/** Runtime configuration may supply keys, but cannot redirect this package's account to another backend. */
export function assertRuntimeBackend(identity: ServerPackageIdentity, configuredUrl: string): void {
  sameBackend(packageIdentity(identity).backendUrl, backendIdentity(configuredUrl))
}

/** All package selectors, including rollback, enter this boundary before activation. */
export function assertPackageEnvironment(home: string, directory: string): void {
  const installation = readInstallation(home)
  if (installation) sameBackend(installation.backendUrl, packageBackend(directory))
}

function legacyBackend(home: string, migrateFrom?: string): string | null {
  if (migrateFrom) {
    if (!/^[0-9][A-Za-z0-9.-]*$/.test(migrateFrom)) throw new Error('Invalid legacy migration version')
    return packageBackend(path.join(home, 'versions', migrateFrom))
  }
  // An old updater may have switched current before the new process starts. Its persisted source
  // is the installation evidence; treating the candidate itself as evidence would bless a cross-backend switch.
  const marker = path.join(home, 'data', 'upgrade-pending.json')
  if (fs.existsSync(marker)) {
    const value = JSON.parse(fs.readFileSync(marker, 'utf8')) as { from?: unknown }
    if (typeof value.from !== 'string' || !/^[0-9][A-Za-z0-9.-]*$/.test(value.from)) throw new Error('Invalid legacy upgrade source')
    return packageBackend(path.join(home, 'versions', value.from))
  }
  const current = path.join(home, 'current')
  if (fs.existsSync(current)) return packageBackend(fs.realpathSync(current))
  const accounts = path.join(home, 'accounts')
  if (fs.existsSync(accounts) && fs.readdirSync(accounts).length && !unusedAccountHome(home, accounts)) {
    throw new Error('Existing account environment cannot be verified; explicit migration is required')
  }
  return null
}

/** Older boot checkers create empty account skeletons before starting a package for the first time. */
function unusedAccountHome(home: string, accounts: string): boolean {
  if (!fs.lstatSync(accounts).isDirectory() || fs.readdirSync(home).some(name => name !== 'accounts')) return false
  return fs.readdirSync(accounts, { withFileTypes: true }).every(account => {
    if (!account.isDirectory()) return false
    const directory = path.join(accounts, account.name)
    const entries = fs.readdirSync(directory, { withFileTypes: true })
    if (entries.length !== 2 || !entries.some(entry => entry.name === 'account.json' && entry.isFile())
      || !entries.some(entry => entry.name === 'data' && entry.isDirectory())) return false
    const metadata: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'account.json'), 'utf8'))
    return metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
      && Object.keys(metadata).length === 0 && fs.readdirSync(path.join(directory, 'data')).length === 0
  })
}

/** Bootstrap and startup share the same contract. Explicit legacy migration names a verified old package. */
export function prepareInstallation(home: string, identity: ServerPackageIdentity,
  options: { updateOwner?: ServerInstallation['updateOwner']; migrateFrom?: string } = {}): ServerInstallation {
  const candidate = packageIdentity(identity)
  const existing = readInstallation(home)
  // A legacy managed supervisor may already have crossed backends. Neither its current package
  // nor another self-update marker proves the original account environment; the controller must migrate it first.
  const accounts = path.join(home, 'accounts')
  if (!existing && options.updateOwner === 'controller' && !options.migrateFrom
    && fs.existsSync(accounts) && fs.readdirSync(accounts).length) {
    throw new Error('Legacy managed server requires an explicit verified migration source')
  }
  const backend = existing?.backendUrl ?? legacyBackend(home, options.migrateFrom)
  if (backend) sameBackend(backend, candidate.backendUrl)
  // Controller ownership is durable: a systemd restart with a smaller environment cannot re-enable self-upgrades.
  const updateOwner = existing?.updateOwner === 'controller' || options.updateOwner === 'controller' ? 'controller' : 'server'
  const installation: ServerInstallation = { ...candidate, updateOwner }
  if (existing && JSON.stringify(existing) === JSON.stringify(installation)) return existing
  fs.mkdirSync(home, { recursive: true })
  const file = path.join(home, SERVER_INSTALLATION)
  if (!existing) {
    try {
      fs.writeFileSync(file, `${JSON.stringify(installation)}\n`, { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return prepareInstallation(home, identity, options)
      throw error
    }
  }
  const temporary = `${file}.${process.pid}.tmp`
  if (existing) {
    fs.writeFileSync(temporary, `${JSON.stringify(installation)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, file)
  }
  // Retain the old reader's discovery setting for a same-backend rollback to an older binary.
  fs.writeFileSync(path.join(home, 'channel'), `${candidate.channel}\n`, { mode: 0o600 })
  return installation
}

export function controllerOwnsUpdates(home: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (home !== '' && readInstallation(home)?.updateOwner === 'controller') || env.GUGU_CLOUD_COMPUTER === '1'
}
