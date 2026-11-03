import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { replaceUsageDeviceRows, type UsageRowsClient } from '@gugu/core/cloud/usageDaily'
import { createUsageSync, USAGE_FIRST_DELAY_MS, USAGE_SYNC_INTERVAL_MS, type UsageSyncDependencies, type UsageSyncState } from '@gugu/core/shared/usage/sync'

/** Account data lives in its own userData directory, never in the server supervisor. */
export function usageSyncStateStore(userData: string): Pick<UsageSyncDependencies, 'readState' | 'writeState'> {
  const file = join(userData, 'usage-sync.json')
  return {
    readState(key) {
      // 这一格只是本地的同步水位。读不出来(损坏、半截、根本不是对象)就从空水位重来 ——
      // 抛出去等于让这个账号的用量同步**永久**停摆,而它每一轮只会再失败一次。
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as { key: string; state: UsageSyncState }
        return saved.key === key ? saved.state : {}
      } catch {
        return {}
      }
    },
    writeState(key, state) {
      const temp = `${file}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify({ key, state }), { mode: 0o600 })
      renameSync(temp, file)
    },
  }
}

export function startServerUsageSync(options: {
  userData: string
  identity: UsageSyncDependencies['identity']
  snapshot: UsageSyncDependencies['snapshot']
  client: UsageRowsClient
  report: (result: string, error?: unknown) => void
}): () => void {
  let stopped = false
  const sync = createUsageSync({
    ...usageSyncStateStore(options.userData),
    identity: () => stopped ? Promise.resolve(null) : options.identity(),
    snapshot: options.snapshot,
    replaceRows: (...args) => replaceUsageDeviceRows(options.client, ...args),
  })
  const run = () => {
    if (stopped) return
    void sync().then(result => options.report(result), error => options.report('failed', error))
  }
  const first = setTimeout(run, USAGE_FIRST_DELAY_MS)
  const timer = setInterval(run, USAGE_SYNC_INTERVAL_MS)
  first.unref?.()
  timer.unref?.()
  return () => { stopped = true; clearTimeout(first); clearInterval(timer) }
}
