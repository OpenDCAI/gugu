export type PendingVerify = { from: string; to: string; attempts: number; request?: number }
export function acquireHomeLock(home: string, alive?: (pid: number) => boolean): (() => void) | null
export function claimHomeLock(home: string): (() => void) | null
export function ownsHomeLock(home: string): boolean
export function readPendingVerify(home: string): PendingVerify | null
export function writePendingVerify(home: string, pending: PendingVerify): void
export function markServerReady(home: string, now?: number): void
