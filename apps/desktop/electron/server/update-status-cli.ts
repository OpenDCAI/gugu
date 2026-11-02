import fs from 'node:fs'
import path from 'node:path'
import { SERVER_UPDATE_STATUS_MARK, parseServerTransition, type ServerUpdateSnapshot } from '@gugu/core/cloud/serverTransition'
import { ACCOUNT_STATE_FILE } from './server-account-machine'
import type { ServerAccount } from './server-layout'

export function updateSnapshot(account: ServerAccount, now = Date.now()): ServerUpdateSnapshot {
  let transition = null
  try {
    const data = JSON.parse(fs.readFileSync(path.join(account.dataDir, ACCOUNT_STATE_FILE), 'utf8')) as { account?: { transition?: unknown } }
    transition = parseServerTransition(data.account?.transition, now)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { at: now, transition }
}

/** Runs outside the account process, including while it is stopped or migrating. */
export async function runUpdateStatus(args: readonly string[], accounts: readonly ServerAccount[], out: (line: string) => void): Promise<number> {
  const id = args[args.indexOf('--account') + 1]
  if (!args.includes('--account') || !id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return 2
  const account = accounts.find(a => a.userId === id && a.signedIn)
  if (!account) return 5
  const after = args.includes('--after') ? Number(args[args.indexOf('--after') + 1]) : null
  if (after !== null && (!Number.isSafeInteger(after) || after < 0)) return 2
  const pendingUntil = after !== null ? Date.now() + 30_000 : 0
  return new Promise(resolve => {
    let previous = ''
    let timer: ReturnType<typeof setInterval> | undefined
    const finish = () => { if (timer) clearInterval(timer); resolve(0) }
    const emit = () => {
      const snapshot = updateSnapshot(account)
      const current = snapshot.transition
      const text = JSON.stringify(current)
      if (text !== previous) { previous = text; out(`${SERVER_UPDATE_STATUS_MARK}${JSON.stringify(snapshot)}`) }
      const active = current && (['accepted', 'stopping', 'starting', 'migrating'].includes(current.phase) || current.search?.state === 'running')
      const waiting = after !== null && (!current || current.request <= after) && Date.now() < pendingUntil
      if (!args.includes('--watch') || (!active && !waiting)) finish()
    }
    // Atomic rename notifications are platform dependent; a small local read also covers missed events.
    timer = setInterval(emit, 500)
    emit()
  })
}
