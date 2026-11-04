import type fs from 'node:fs'
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process'
export type LockSnapshot = { pid: number; dev: bigint; ino: bigint }
export type AccountLockDeps = { read?: (file: string) => string | null; alive?: (pid: number) => boolean; ownsLock?: (pid: number, file: string) => boolean }
export type AccountLockInspector = (command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>
export function createAccountLockProbe(runtime: { fs: typeof fs; spawnSync: AccountLockInspector; platform: NodeJS.Platform; kill: (pid: number, signal: 0) => unknown }): {
  directories(home: string): string[]
  alive(pid: number): boolean
  snapshot(file: string): LockSnapshot | null
  same(a: Pick<LockSnapshot, 'dev' | 'ino'>, b: Pick<LockSnapshot, 'dev' | 'ino'>): boolean
  owns(pid: number, file: string, expected?: Pick<LockSnapshot, 'dev' | 'ino'>): boolean
  holder(dataDir: string, deps?: AccountLockDeps): number | null
}
