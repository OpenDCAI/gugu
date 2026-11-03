import { spawnSync } from '@gugu/core/local/childProcess'
import fs from 'node:fs'
import { createAccountLockProbe } from './server-account-lock-probe.cjs'
export type { AccountLockDeps } from './server-account-lock-probe.cjs'

const probe = createAccountLockProbe({ fs, spawnSync, platform: process.platform, kill: (pid, signal) => process.kill(pid, signal) })
export const accountLockHolder = probe.holder
export const sameAccountLockInode = probe.same
// true/false are verified results. Unknown inspection throws and never grants
// permission to reclaim a lock or signal an unverified PID.
export const processOwnsAccountLock = probe.owns
