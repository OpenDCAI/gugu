import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.each(['Asia/Shanghai', 'UTC', 'America/New_York'])('uses UTC for SQLite creation times in %s', timezone => {
  const script = `
    import { agentNamingUntil } from './packages/core/src/shared/agentDefaultName.ts'
    const sqlite = '2026-11-02 10:00:00'
    const created = Date.parse('2026-11-02T10:00:00Z')
    const deadline = (value, now) => agentNamingUntil('Codex 5', 'codex', value, now)
    console.log(JSON.stringify({
      timezone: process.env.TZ,
      nativeParsed: Date.parse(sqlite),
      justCreated: deadline(sqlite, created),
      beforeExpiry: deadline(sqlite, created + 59_999),
      expired: deadline(sqlite, created + 60_000),
      old: deadline(sqlite, created + 3_600_000),
      fractional: deadline(sqlite + '.125', created),
      iso: deadline('2026-11-02T10:00:00Z', created),
      offset: deadline('2026-11-02T18:00:00+08:00', created),
      numeric: deadline(created, created),
    }))
  `
  const value = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
    env: { TZ: timezone, NODE_ENV: 'test' }, encoding: 'utf8',
  }))
  const created = Date.parse('2026-11-02T10:00:00Z')
  expect(value.timezone).toBe(timezone)
  if (timezone === 'UTC') expect(value.nativeParsed).toBe(created)
  else expect(value.nativeParsed).not.toBe(created)
  expect(value).toMatchObject({ justCreated: created + 60_000, beforeExpiry: created + 60_000,
    expired: null, old: null, fractional: created + 60_125, iso: created + 60_000, offset: created + 60_000, numeric: created + 60_000 })
})
