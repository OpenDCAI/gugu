import { updateStateAdvances } from './update-policy'

export type VersionedUpdateState<T> = T & { revision: number }

/** The host stamps both pushed states and query replies from the same sequence. */
export function createUpdateState<T extends { status: string }>(initial: T) {
  let current: VersionedUpdateState<T> = { ...initial, revision: 0 }
  return {
    get current(): VersionedUpdateState<T> { return current },
    publish(next: T): VersionedUpdateState<T> | null {
      if (!updateStateAdvances(current.status, next.status)) return null
      current = { ...next, revision: current.revision + 1 }
      return current
    },
  }
}

/** Receive only newer host revisions, regardless of IPC reply/event ordering. */
export function createUpdateStateReceiver() {
  let revision = -1
  return (next: { revision?: unknown } | null | undefined): boolean => {
    const value = next?.revision
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value <= revision) return false
    revision = value
    return true
  }
}
