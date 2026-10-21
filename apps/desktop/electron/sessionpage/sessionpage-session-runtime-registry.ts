/**
 * Host-owned provider runtimes keyed by the product conversation.
 *
 * A controlled session-page restart must dispose every native runtime that can retain the
 * previous process environment or credential. The host should not know which harness owns
 * which transport, so each adapter registers one conversation teardown hook here. Hooks are
 * deliberately no-op for conversations they do not own.
 */

export interface SessionpageSessionRuntime {
  readonly name: string
  teardown(sessionId: string): Promise<void>
}

const runtimes: SessionpageSessionRuntime[] = []

export function registerSessionpageSessionRuntime(runtime: SessionpageSessionRuntime): void {
  if (runtimes.some((existing) => existing.name === runtime.name)) {
    throw new Error(`sessionpage session runtime already registered: ${runtime.name}`)
  }
  runtimes.push(runtime)
}

export async function teardownSessionpageSessionRuntimes(sessionId: string): Promise<void> {
  const results = await Promise.allSettled(
    runtimes.map((runtime) => runtime.teardown(sessionId)),
  )
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [new Error(
      `sessionpage runtime ${runtimes[index].name} teardown failed for ${sessionId}`,
      { cause: result.reason },
    )]
    : [])
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, `sessionpage runtime teardown failed for ${sessionId}`)
  }
}
