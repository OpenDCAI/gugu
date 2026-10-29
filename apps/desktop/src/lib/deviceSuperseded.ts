import type { Device } from '@gugu/core/shared/types/chat'

/**
 * A row that may have been replaced (owner 10-28, option a): a server's device id is its data directory's install id, so
 * a reinstall or a new data directory is a new row and the old one stays — the database never ties them together, and
 * only the hostname is the same. An offline row is marked "may have been replaced by" an online one when they:
 * - have the same hostname (case aside), and are the same kind of machine (both a gugu server, or both a desktop: a desktop
 *   and a server on one computer share a hostname and replace nothing);
 * - are different machines (machine_id);
 * - the online one came later (created_at) and was seen later (last_seen_at) — a long-running machine now offline is not
 *   "replaced" by a newer one that happens to share its name before that one appeared.
 * Two machines can rightly share a hostname: this is a hint ("may have"), and removing is the person's, confirmed.
 * Answers, per replaced row, the row that may have replaced it (the newest when several do).
 */
export function supersededBy(devices: readonly Device[]): Map<string, Device> {
  const found = new Map<string, Device>()
  const hostOf = (device: Device) => device.hostname.trim().toLowerCase()
  const kindOf = (device: Device) => (device.capabilities.host_kind === 'server' ? 'server' : device.capabilities.host_kind === 'phone' ? 'phone' : 'desktop')
  const comparable = (device: Device) => device.platform !== 'cloud' && !device.cloud_computer && kindOf(device) !== 'phone' && !!hostOf(device)
  for (const old of devices) {
    if (old.is_online || !comparable(old) || !old.created_at) continue
    let by: Device | null = null
    for (const other of devices) {
      if (other === old || !other.is_online || !comparable(other) || !other.created_at) continue
      if (hostOf(other) !== hostOf(old) || kindOf(other) !== kindOf(old)) continue
      if (old.machine_id && other.machine_id === old.machine_id) continue
      if (!(Date.parse(other.created_at) > Date.parse(old.created_at))) continue
      if (!(Date.parse(other.last_seen_at) > Date.parse(old.last_seen_at))) continue
      if (!by || Date.parse(other.created_at) > Date.parse(by.created_at!)) by = other
    }
    if (by) found.set(old.device_id, by)
  }
  return found
}
