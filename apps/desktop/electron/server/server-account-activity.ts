import { join } from 'node:path'
import { atomicWriteText } from '@gugu/core/local/state/paths'

type Activity = { busy: boolean; busyAgents: number; bootFailures?: unknown }

/** The account's sole heartbeat publisher. Unknown ownership never publishes idle. */
export function startServerAccountActivity(options: {
  dataDir: string
  version: string | null
  read: () => Promise<Activity>
  subscribe: (listener: () => void) => () => void
  warn: (error: unknown) => void
  now?: () => number
}) {
  const now = options.now ?? Date.now
  const startedAt = now()
  let revision = 0
  let dirty = false
  let stopped = false
  let pending: Promise<void> | null = null
  const report = (): Promise<void> => {
    revision++
    dirty = true
    pending ??= Promise.resolve().then(async () => {
      while (dirty && !stopped) {
        dirty = false
        const reading = revision
        let activity: Activity | { busy: null }
        try { activity = await options.read() }
        catch (error) { activity = { busy: null }; options.warn(error) }
        // Ownership changed while the asynchronous worker read was in flight.
        if (reading !== revision) continue
        try {
          await atomicWriteText(join(options.dataDir, 'activity.json'), JSON.stringify({
            ...activity, runtimeOwned: true, at: now(), version: options.version, pid: process.pid, startedAt,
          }))
        } catch (error) { options.warn(error) }
      }
    }).finally(() => {
      pending = null
      if (dirty && !stopped) void report()
    })
    return pending
  }
  let unsubscribe = () => {}
  try { unsubscribe = options.subscribe(() => { void report() }) }
  catch (error) { options.warn(error) }
  void report()
  const timer = setInterval(() => { void report() }, 10_000)
  timer.unref()
  return {
    report,
    dispose() { stopped = true; clearInterval(timer); unsubscribe() },
  }
}
