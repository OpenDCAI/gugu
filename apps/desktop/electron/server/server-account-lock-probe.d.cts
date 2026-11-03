import type fs from 'node:fs'
import type { spawnSync } from 'node:child_process'
export type LockSnapshot = { pid: number; dev: bigint; ino: bigint }
export type AccountLockDeps = { read?: (file: string) => string | null; alive?: (pid: number) => boolean; ownsLock?: (pid: number, file: string) => boolean }
export function createAccountLockProbe(runtime: { fs: typeof fs; spawnSync: typeof spawnSync; platform: NodeJS.Platform; kill: (pid: number, signal: 0) => unknown }): {
  alive(pid: number): boolean
  snapshot(file: string): LockSnapshot | null
  same(a: Pick<LockSnapshot, 'dev' | 'ino'>, b: Pick<LockSnapshot, 'dev' | 'ino'>): boolean
  owns(pid: number, file: string, expected?: Pick<LockSnapshot, 'dev' | 'ino'>): boolean
  holder(dataDir: string, deps?: AccountLockDeps): number | null
}
