export type PlatformRecoveryReadyResult =
  | { status: 'ready' }
  | { status: 'failed'; error: string }

type PlatformRecoveryReadyGate = (
  sessionId: string,
  trigger: string,
) => Promise<PlatformRecoveryReadyResult>

let readyGate: PlatformRecoveryReadyGate | null = null

/** Install the host coordinator's gate; this module holds no recovery state of its own. */
export function setPlatformRecoveryReadyGate(next: PlatformRecoveryReadyGate): void {
  readyGate = next
}

export async function ensurePlatformSessionReady(
  sessionId: string,
  trigger: string,
): Promise<PlatformRecoveryReadyResult> {
  if (!readyGate) throw new Error('platform recovery coordinator is unavailable')
  return readyGate(sessionId, trigger)
}
