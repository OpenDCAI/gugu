/** Installation package staging, reclamation and verified current-pointer activation. */
import { checkAccountBoot } from './server-selftest'
import fs from 'node:fs'
import path from 'node:path'
import { pruneVersions, readVersionPin } from './server-account-versions'
import { activityProof, listAccounts } from './server-layout'
import { assertPackageEnvironment } from './server-package-environment.mts'
import { pointCurrent as pointCurrentFile } from './server-boot.cjs'
import { legacyGuardActive, readBadVersions, readPendingVerify, writePendingVerify } from './server-startup'
import { createServerUpdateStateWriter, readUpdateRecord } from './server-update-state'

/** The staged package installed but did not boot an account: a boot failure, not an install failure. */
export class AccountBootRejectedError extends Error {}
export class ServerPackageDeferredError extends Error {}

export type ServerTransition = { from: string; to: string; fromDir: string; toDir: string; switchedAt: number; request?: number }
const dataDir = (home: string) => path.join(home, 'data')

export function pointCurrent(home: string, versionDir: string): void {
  assertPackageEnvironment(home, versionDir)
  pointCurrentFile(home, versionDir)
}

export type ServerVersionLifecycle = ReturnType<typeof createServerVersionLifecycle>
export function createServerVersionLifecycle(options: {
  layout: { home: string; versions: string; version: string }
  running?: () => Iterable<string>
  /** 试跑一个账号(缺省:真的起一个,见 server-selftest.ts checkAccountBoot)。 */
  verifyBoot?: (binary: string) => Promise<void>
}) {
  const { layout } = options
  const flights = new Map<string, { promise: Promise<void>; ready: boolean }>()
  const held = new Map<string, string>()
  const ready = (version: string): boolean => flights.get(version)?.ready === true
    && fs.existsSync(path.join(layout.versions, version, 'bin', 'gugu-server'))
  const requireBoot = (version: string): void => {
    if (!ready(version)) throw new Error('Target version has not passed account boot verification')
  }
  const reclaim = (): string[] => {
    const previous = readUpdateRecord(layout.home)?.previous
    // A legacy verified pin is read only for reclamation during the transition.
    const legacy = previous ? null : readVersionPin(dataDir(layout.home))
    if (!previous && !legacy) return []
    const keep = new Set([layout.version,
      ...[...flights].filter(([, stage]) => !stage.ready).map(([version]) => version),
      ...held.values(), ...(options.running?.() ?? [])])
    if (previous) keep.add(previous)
    if (legacy) { keep.add(legacy.version); if (legacy.previous) keep.add(legacy.previous) }
    try { keep.add(path.basename(fs.realpathSync(path.join(layout.home, 'current')))) } catch { return [] }
    const pending = readPendingVerify(layout.home)
    if (pending) { keep.add(pending.from); keep.add(pending.to) }
    // install.sh publishes this lease BEFORE its target directory becomes visible. Recheck at deletion.
    const removed = pruneVersions(layout.versions, keep, version => fs.existsSync(path.join(layout.versions, '.prepared', version)))
    for (const version of removed) flights.delete(version)
    return removed
  }
  return {
    ready,
    hold(owner: string, version: string | null): void { if (version) held.set(owner, version); else held.delete(owner) },
    async stage(version: string, work: () => Promise<unknown>): Promise<void> {
      const existing = flights.get(version)
      if (existing && (!existing.ready || fs.existsSync(path.join(layout.versions, version, 'bin', 'gugu-server')))) return existing.promise
      // The lease is installed before any await. Both consumers share this exact in-flight operation.
      let resolve!: () => void
      let reject!: (error: unknown) => void
      const flight = new Promise<void>((ok, fail) => { resolve = ok; reject = fail })
      const stage = { promise: flight, ready: false }
      flights.set(version, stage)
      try {
        Promise.resolve(work())
          .then(() => assertPackageEnvironment(layout.home, path.join(layout.versions, version)))
          .then(() => Promise.resolve((options.verifyBoot ?? checkAccountBoot)(path.join(layout.versions, version, 'bin', 'gugu-server')))
            .catch((error: unknown) => { throw new AccountBootRejectedError(error instanceof Error ? error.message : String(error)) }))
          .then(() => { stage.ready = true; resolve() }, reject)
      } catch (error) { reject(error) }
      try { await flight } catch (error) {
        if (flights.get(version) === stage) flights.delete(version)
        throw error
      }
    },
    switchSupervisor(marker: ServerTransition, beforeSwitch: () => void): void {
      requireBoot(marker.to)
      assertPackageEnvironment(layout.home, marker.toDir)
      writePendingVerify(layout.home, { from: marker.from, to: marker.to, attempts: 0,
        ...(marker.request !== undefined ? { request: marker.request } : {}) })
      try {
        createServerUpdateStateWriter(layout.home).set('switching', marker.to)
        beforeSwitch()
        pointCurrent(layout.home, marker.toDir)
      } catch (error) {
        fs.rmSync(path.join(layout.home, 'data/pending-verify.json'), { force: true })
        throw error
      }
      // The new run releases its own publication lease after taking the home lock.
    },
    reclaim,
  }
}

/** Controller handoff shares verification, pending attempts and the installation update record. */
export async function activateServerPackage(home: string, directory: string, options: {
  migrateFrom?: string
  verifyBoot?: (binary: string) => Promise<void>
  beforeSwitch?: () => void
  isBusy?: () => boolean
}): Promise<void> {
  const versions = fs.realpathSync(path.join(home, 'versions'))
  const target = fs.realpathSync(directory)
  if (path.dirname(target) !== versions) throw new Error('Candidate is outside the installation')
  if (readBadVersions(home)[path.basename(target)] !== undefined) {
    throw new ServerPackageDeferredError('Server package previously failed and was rolled back; waiting for another release')
  }
  const current = path.join(home, 'current')
  const previous = fs.existsSync(current) ? fs.realpathSync(current) : target
  if (options.migrateFrom && !/^[0-9][A-Za-z0-9.-]*$/.test(options.migrateFrom)) throw new Error('Invalid legacy migration version')
  const from = options.migrateFrom ? fs.realpathSync(path.join(versions, options.migrateFrom)) : previous
  if (path.dirname(from) !== versions) throw new Error('Rollback version is outside the installation')
  assertPackageEnvironment(home, from)
  const layout = { home, versions, version: path.basename(from) }
  const lifecycle = createServerVersionLifecycle({ layout, verifyBoot: options.verifyBoot })
  await lifecycle.stage(path.basename(target), async () => {})
  if (target === previous) return
  createServerUpdateStateWriter(home).set('ready', path.basename(target))
  const busy = options.isBusy ?? (() => listAccounts().some(account => account.signedIn && activityProof(account.dataDir) !== 'idle'))
  if (legacyGuardActive(home)) throw new ServerPackageDeferredError('The legacy upgrade guard still owns the current transition')
  if (busy()) throw new ServerPackageDeferredError('Accounts are no longer idle; package activation was deferred')
  lifecycle.switchSupervisor({ from: path.basename(from), to: path.basename(target), fromDir: from,
    toDir: target, switchedAt: Date.now() }, options.beforeSwitch ?? (() => {}))
}
