/** Supervisor-owned version lifecycle, shared by account matching, self-upgrade and its watchdog. */
import { pickTargetVersion, readDesktopReports } from '@gugu/core/cloud/serverDesktopVersions'
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
}) {
  const { layout } = options
  const flights = new Map<string, Promise<void>>()
  const held = new Map<string, string>()
  const reclaim = (): string[] => {
    const supervisor = readAccountVersionPin(dataDir(layout.home))
    // Old installations did not record previous. Preserve their directories until a verified transition supplies it.
    if (!supervisor) return []
    const keep = new Set([layout.version, supervisor.version, ...flights.keys(), ...held.values(), ...(options.running?.() ?? [])])
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
    return pruneVersions(layout.versions, keep)
  }
  return {
    hold(owner: string, version: string | null): void { if (version) held.set(owner, version); else held.delete(owner) },
    async stage(version: string, work: () => Promise<unknown>): Promise<void> {
      const existing = flights.get(version)
      if (existing) return existing
      // The lease is installed before any await. Both consumers share this exact in-flight operation.
      const flight = Promise.resolve().then(work).then(() => undefined)
      flights.set(version, flight)
      try { await flight } finally { if (flights.get(version) === flight) flights.delete(version) }
    },
    switchAccount(data: string, version: string, previous: string | null, at: number): void {
      writeAccountVersionPin(data, { version, previous, at })
      touchVersion(layout.versions, version)
    },
    rollbackAccount(data: string, previous: string | null, at: number): void {
      if (previous) writeAccountVersionPin(data, { version: previous, previous: null, at })
      else fs.rmSync(path.join(data, ACCOUNT_VERSION_FILE), { force: true })
    },
    switchSupervisor(marker: UpgradeMarker, beforeSwitch: () => void): void {
      if (!writeUpgradeMarker(layout.home, marker)) throw new Error('Cannot persist the upgrade rollback pointer')
      beforeSwitch()
      pointCurrent(layout.home, marker.toDir)
    },
    reclaim,
  }
}
