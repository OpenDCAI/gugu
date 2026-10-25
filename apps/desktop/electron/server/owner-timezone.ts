import { setOwnerTimeZoneContext, type OwnerTimeZoneContext } from '../../src/session/shared/core/automations/timezone'

/** Controller-supplied account facts, never a machine-wide time zone change. */
export function parseOwnerTimeZoneContext(value: unknown): OwnerTimeZoneContext {
  const row = typeof value === 'string' ? JSON.parse(value) : value
  if (!row || typeof row !== 'object' || Array.isArray(row)
    || typeof row.time_zone !== 'string' || !['device', 'cached', 'unknown'].includes(row.status)
    || !(row.source_device_id === null || (typeof row.source_device_id === 'string' && row.source_device_id.length <= 256))
    || !(row.source_last_seen_at === null || (typeof row.source_last_seen_at === 'string' && Number.isFinite(Date.parse(row.source_last_seen_at))))
    || typeof row.read_at !== 'string' || !Number.isFinite(Date.parse(row.read_at))
    || (row.status === 'unknown' && (row.time_zone !== 'UTC' || row.source_device_id !== null || row.source_last_seen_at !== null))
    || (row.status !== 'unknown' && !row.source_device_id)) {
    throw Error('Invalid owner time-zone context')
  }
  new Intl.DateTimeFormat('en-US', { timeZone: row.time_zone })
  return { time_zone: row.time_zone, source_device_id: row.source_device_id,
    source_last_seen_at: row.source_last_seen_at, read_at: row.read_at, status: row.status }
}

export function applyOwnerTimeZoneContext(value: unknown, env: NodeJS.ProcessEnv = process.env): void {
  if (env.GUGU_CLOUD_COMPUTER !== '1') throw Error('Owner time-zone context applies only to a hosted account')
  const context = parseOwnerTimeZoneContext(value)
  env.TZ = context.time_zone
  env.GUGU_OWNER_TIME_ZONE_CONTEXT = JSON.stringify(context)
  setOwnerTimeZoneContext(context)
}

export function ownerTimeZoneFromEnvironment(env: NodeJS.ProcessEnv = process.env): OwnerTimeZoneContext | undefined {
  return env.GUGU_CLOUD_COMPUTER === '1' && env.GUGU_OWNER_TIME_ZONE_CONTEXT
    ? parseOwnerTimeZoneContext(env.GUGU_OWNER_TIME_ZONE_CONTEXT) : undefined
}
