export type PendingVerify = { from: string; to: string; attempts: number; request?: number }
export function acquireHomeLock(home: string, alive?: (pid: number) => boolean): (() => void) | null
export function claimHomeLock(home: string): (() => void) | null
export function ownsHomeLock(home: string): boolean | undefined
export function homeLockHolder(home: string, alive?: (pid: number) => boolean): number | null
export function readPendingVerify(home: string): PendingVerify | null
export function writePendingVerify(home: string, pending: PendingVerify): void
export function markServerReady(home: string, now?: number): void
export function writeJson(file: string, value: unknown): void
export function pointCurrent(home: string, directory: string): void
export function readBadVersions(home: string): Record<string, number>
export function legacyGuardActive(home: string): boolean
export function migrateAccountLayout(home: string): void
export function prepareAccountLogin(home: string, userId: string): void
