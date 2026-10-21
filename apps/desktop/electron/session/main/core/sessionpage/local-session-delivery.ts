/**
 * Session-page side of the local-session host boundary: main installs the host-owned registry through
 * `setLocalSessionDeliveryBridge` before any PTY lifecycle callback can run. The types are the host's own
 * (`import type` is erased at build time, so no host code enters this bundle).
 */
import type {
  LocalSessionBinding,
  LocalSessionDeliveryBridge,
} from '../../../../sessionpage/local-session-delivery'

export type { LocalSessionDeliveryBridge } from '../../../../sessionpage/local-session-delivery'

let bridge: LocalSessionDeliveryBridge | null = null

/** Install/replace the host-owned implementation at the module boundary. */
export function setLocalSessionDeliveryBridge(next: LocalSessionDeliveryBridge | null): void {
  bridge = next
}

export function registerLocalSessionDelivery(
  agentUserId: string,
  binding: LocalSessionBinding,
): void {
  if (!bridge) throw new Error('session-page local-session delivery bridge is not installed')
  bridge.registerLive(agentUserId, binding)
}

export function replaceLiveWithOfflineForSession(sessionId: string): boolean {
  return bridge?.replaceLiveWithOfflineForSession(sessionId) ?? false
}

export function unregisterLocalSessionDelivery(sessionId: string): void {
  bridge?.unregisterSession(sessionId)
}

export function recordLocalSessionDeliveryFailureForTest(entry: {
  sessionId: string
  providerId: string
  messageId: string
  text: string
  error: string
}): void {
  bridge?.recordDeliveryFailure?.(entry)
}
