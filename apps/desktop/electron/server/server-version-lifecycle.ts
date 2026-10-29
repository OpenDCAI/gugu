/** Supervisor-owned version lifecycle, shared by account matching, self-upgrade and its watchdog. */
import { pickTargetVersion, readDesktopReports } from '@gugu/core/cloud/serverDesktopVersions'
import { checkAccountBoot } from './server-selftest'
import fs from 'node:fs'
import path from 'node:path'
import { pruneVersions, readAccountVersionPin, writeAccountVersionPin, touchVersion, ACCOUNT_VERSION_FILE } from './server-account-versions'
import { listAccounts } from './server-layout'

export const UPGRADE_PENDING_FILE = 'upgrade-pending.json'
export type UpgradeMarker = { from: string; to: string; fromDir: string; toDir: string; switchedAt: number }
const dataDir = (home: string) => path.join(home, 'data')

export function readUpgradeMarker(home: string): UpgradeMarker | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir(home), UPGRADE_PENDING_FILE), 'utf8')) as Partial<UpgradeMarker>
    return typeof value.from === 'string' && typeof value.to === 'string' && typeof value.fromDir === 'string'
      && typeof value.toDir === 'string' && typeof value.switchedAt === 'number' ? value as UpgradeMarker : null
  } catch { return null }
}

export function writeUpgradeMarker(home: string, marker: UpgradeMarker): boolean {
  const file = path.join(dataDir(home), UPGRADE_PENDING_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(marker), { mode: 0o600 })
    fs.renameSync(tmp, file)
    return true
  } catch { fs.rmSync(tmp, { force: true }); return false }
}

export function clearUpgradeMarker(home: string): void {
  fs.rmSync(path.join(dataDir(home), UPGRADE_PENDING_FILE), { force: true })
}

export function pointCurrent(home: string, versionDir: string): void {
  const versions = fs.realpathSync(path.join(home, 'versions'))
  if (path.dirname(fs.realpathSync(versionDir)) !== versions) throw new Error('Version is outside the managed versions directory')
  const current = path.join(home, 'current')
  const tmp = `${current}.tmp-${process.pid}`
  fs.rmSync(tmp, { force: true })
  fs.symlinkSync(path.relative(home, versionDir), tmp)
  fs.renameSync(tmp, current)
}

/** The watchdog records an actual successful transition, never a directory-number or mtime guess. */
export function recordVerifiedSupervisorVersion(home: string, marker: UpgradeMarker): void {
  writeAccountVersionPin(dataDir(home), { version: marker.to, previous: marker.from, at: marker.switchedAt })
}

export type ServerVersionLifecycle = ReturnType<typeof createServerVersionLifecycle>
export function createServerVersionLifecycle(options: {
  layout: { home: string; versions: string; version: string }
  running?: () => Iterable<string>
  verifyBoot?: (binary: string) => Promise<void | { runtimeOwned: boolean }>
}) {
  const { layout } = options
  const flights = new Map<string, { promise: Promise<void>; ready: boolean; runtimeOwned: boolean }>()
  const held = new Map<string, string>()
  const ready = (version: string): boolean => flights.get(version)?.ready === true
    && fs.existsSync(path.join(layout.versions, version, 'bin', 'gugu-server'))
  const requireBoot = (version: string): void => {
    if (!ready(version)) throw new Error('Target version has not passed account boot verification')
  }
  const reclaim = (): string[] => {
    const supervisor = readAccountVersionPin(dataDir(layout.home))
    // Old installations did not record previous. Preserve their directories until a verified transition supplies it.
    if (!supervisor) return []
    const keep = new Set([layout.version, supervisor.version,
      ...[...flights].filter(([, stage]) => !stage.ready).map(([version]) => version),
      ...held.values(), ...(options.running?.() ?? [])])
    if (supervisor.previous) keep.add(supervisor.previous)
    try { keep.add(path.basename(fs.realpathSync(path.join(layout.home, 'current')))) } catch { return [] }
    const marker = readUpgradeMarker(layout.home)
    if (marker) { keep.add(marker.from); keep.add(marker.to) }
    for (const account of listAccounts()) {
      const target = pickTargetVersion(readDesktopReports(account.dataDir), Date.now())
      if (target) keep.add(target)
      const pin = readAccountVersionPin(account.dataDir)
      if (pin) { keep.add(pin.version); if (pin.previous) keep.add(pin.previous) }
    }
    // install.sh publishes this lease BEFORE its target directory becomes visible. Recheck at deletion.
    const removed = pruneVersions(layout.versions, keep, version => fs.existsSync(path.join(layout.versions, '.prepared', version)))
    for (const version of removed) flights.delete(version)
    return removed
  }
  return {
    ready,
    runtimeOwned: (version: string): boolean => ready(version) && flights.get(version)?.runtimeOwned === true,
    hold(owner: string, version: string | null): void { if (version) held.set(owner, version); else held.delete(owner) },
    async stage(version: string, work: () => Promise<unknown>): Promise<void> {
      const existing = flights.get(version)
      if (existing && (!existing.ready || fs.existsSync(path.join(layout.versions, version, 'bin', 'gugu-server')))) return existing.promise
      // The lease is installed before any await. Both consumers share this exact in-flight operation.
      let resolve!: () => void
      let reject!: (error: unknown) => void
      const flight = new Promise<void>((ok, fail) => { resolve = ok; reject = fail })
      const stage = { promise: flight, ready: false, runtimeOwned: false }
      flights.set(version, stage)
      try {
        Promise.resolve(work())
          .then(() => (options.verifyBoot ?? checkAccountBoot)(path.join(layout.versions, version, 'bin', 'gugu-server')))
          .then(proof => { stage.ready = true; stage.runtimeOwned = proof ? proof.runtimeOwned : options.verifyBoot !== undefined; resolve() }, reject)
      } catch (error) { reject(error) }
      try { await flight } catch (error) {
        if (flights.get(version) === stage) flights.delete(version)
        throw error
      }
    },
    switchAccount(data: string, version: string, previous: string | null, at: number): void {
      requireBoot(version)
      writeAccountVersionPin(data, { version, previous, at })
      fs.rmSync(path.join(layout.versions, '.prepared', version), { force: true })
      touchVersion(layout.versions, version)
    },
    rollbackAccount(data: string, previous: string | null, at: number): void {
      if (previous) writeAccountVersionPin(data, { version: previous, previous: null, at })
      else fs.rmSync(path.join(data, ACCOUNT_VERSION_FILE), { force: true })
    },
    switchSupervisor(marker: UpgradeMarker, beforeSwitch: () => void): void {
      requireBoot(marker.to)
      if (!writeUpgradeMarker(layout.home, marker)) throw new Error('Cannot persist the upgrade rollback pointer')
      beforeSwitch()
      pointCurrent(layout.home, marker.toDir)
      fs.rmSync(path.join(layout.versions, '.prepared', marker.to), { force: true })
    },
    reclaim,
  }
}
