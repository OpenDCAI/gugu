export type FailureCause = 'install' | 'unreachable' | 'boot'
/** The installation updater's result; request identifies the host-written request timestamp. */
export type Outcome =
  | { kind: 'switched'; target: string; at: number; request?: number }
  | { kind: 'rolledBack'; bad: string; back: string | null; at: number; request?: number }
  | { kind: 'failed'; target: string; cause: FailureCause; at: number; request?: number }
  | { kind: 'refused'; target: string; cause: FailureCause; at: number; request: number }
  | { kind: 'waiting'; target: string; at: number; request: number }

export type VersionRequestOutcome = Pick<Outcome, 'kind'> & { request: number }

/** Device rows need only the result kind and its request identity, not the rest of the update state. */
export function parseVersionRequestOutcome(value: unknown): VersionRequestOutcome | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (typeof row.request !== 'number' || !Number.isFinite(row.request)) return undefined
  switch (row.kind) {
    case 'switched': case 'rolledBack': case 'failed': case 'refused': case 'waiting':
      return { kind: row.kind, request: row.request }
    default: return undefined
  }
}
