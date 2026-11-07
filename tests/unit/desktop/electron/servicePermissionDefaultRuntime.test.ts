import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { awaitPending } from '../../../support/awaitFact'
import { PrivatePermissionRecords } from '../../../../apps/desktop/electron/permissions/private-records'
import { defaultPermissionPolicy } from '../../../../apps/desktop/electron/permissions/rules'

const host = vi.hoisted(() => ({ client: {} as unknown, token: `x.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.x` }))
vi.mock('../../../../apps/desktop/electron/session/main/core/extensions/account-token', () => ({ currentAccountAccessToken: async () => host.token }))
vi.mock('../../../../apps/desktop/electron/supabase', () => ({ makeIdentityClient: () => host.client }))
const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.resetModules()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
const caller = { ownerId: 'owner', subjectId: 'agent-a', sessionId: 'task-a', toolScope: 'gugu' }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-permission-default-'))
  directories.push(directory)
  vi.stubEnv('GUGU_HOME', directory)
  const state = { fail: false }
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const abortSignal = vi.fn()
  const maybeSingle = vi.fn(async () => {
    if (state.fail) return { data: null, error: { message: 'unavailable' } }
    await pending
    return { data: { scope: 'user', config: { service_permissions: defaultPermissionPolicy() }, updated_at: '2026-01-01T00:00:00Z' }, error: null }
  })
  const query = { eq: (_column: string, _value: string) => query, maybeSingle,
    abortSignal: (signal: AbortSignal) => { abortSignal(signal); return query } }
  host.client = { from: () => ({ select: () => query }) }
  const { defaultServicePermissionRuntime } = await import('../../../../apps/desktop/electron/permissions/default-runtime')
  const runtime = defaultServicePermissionRuntime()
  return { directory, state, release, maybeSingle, abortSignal, runtime }
}
async function loaded(runtime: Awaited<ReturnType<typeof fixture>>['runtime']) {
  await awaitPending('observation policy becomes available', (async () => {
    for (;;) {
      const attempt = await runtime.begin(caller, 'guide_topics', {}, new AbortController().signal)
      if (attempt.decision.effect === 'allow') return
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  })())
}

describe('production observation and enforcement policy reads', () => {
  it('does not await cloud I/O in observation, and marks an unknown snapshot explicitly', async () => {
    const f = await fixture()
    const attempt = await f.runtime.begin(caller, 'guide_topics', {}, new AbortController().signal)
    expect(attempt.execute).toBe(true)
    expect(attempt.decision.reason).toBe('policy_unavailable')
    const value = { content: [{ type: 'text', text: 'unchanged raw output' }] }
    expect(await attempt.finish(value, false)).toBe(value)
    f.release()
    await loaded(f.runtime)
    expect(f.maybeSingle).toHaveBeenCalledTimes(1)
    expect(f.abortSignal).toHaveBeenCalledTimes(1)
  })
  it('does not reuse an observed allow when enforcement becomes enabled', async () => {
    const f = await fixture()
    await f.runtime.begin(caller, 'guide_topics', {}, new AbortController().signal)
    f.release()
    await loaded(f.runtime)
    const records = new PrivatePermissionRecords(join(f.directory, 'private-service-permissions'))
    await records.setEnforcement({ kind: 'person', userId: 'owner' }, 'owner', true)
    f.state.fail = true
    const attempt = await f.runtime.begin(caller, 'guide_topics', {}, new AbortController().signal)
    expect(attempt.execute).toBe(false)
    expect(attempt.decision.reason).toBe('policy_unavailable')
    expect(f.maybeSingle.mock.calls.length).toBeGreaterThan(1)
  })
})
