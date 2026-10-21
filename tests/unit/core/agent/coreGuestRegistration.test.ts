import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  activateGuestAgent,
  attachFreeformAgent,
  createAgent,
  deviceFile,
  listAgents,
  readAgentRuntimeSession,
  updateAgent,
  removeAgents,
  matchAgentByProviderSessionId,
  isGuestAgentRecord,
  createGuestAgentForProviderSession,
  ensureGuestForProviderSession,
  resolveAgentRuntimeSessionIdentity,
  writeDeviceIdCache,
  writeHumanAuthSession,
} from '@gugu/core'
import { isolatedGuguEnv } from '../../../support/deviceRuntimeHarness'

const isolatedEnv = () => isolatedGuguEnv('gugu-guest-reg-')

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// ensureGuestForSession
// ---------------------------------------------------------------------------

describe('ensureGuestForSession', () => {
  test('creates a guest record bound to the session id (claude-code)', async () => {
    const env = await isolatedEnv()
    const payload = JSON.stringify({ session_id: 'sess-abc123' })
    const result = await ensureGuestForProviderSession('claude-code', payload, { env, cwd: '/myproject' })

    expect(result.created).toBe(true)
    expect(result.record).not.toBeNull()
    expect(result.record!.status).toBe('guest')
    expect(result.record!.gugu_user_id).toBe('')
    expect(result.record!.agent_type).toBe('claude-code')
    expect(result.record!.path).toBe('/myproject')
    // cache must contain the session id for matchAgentBySessionId to work
    expect(result.record!.cache?.provider_session_id).toBe('sess-abc123')
  })

  test('creates a guest record bound to thread_id (codex)', async () => {
    const env = await isolatedEnv()
    const payload = JSON.stringify({ thread_id: 'thread-xyz' })
    const result = await ensureGuestForProviderSession('codex', payload, { env })

    expect(result.created).toBe(true)
    expect(result.record!.cache?.provider_session_id).toBe('thread-xyz')
    expect(result.record!.agent_type).toBe('codex')
  })

  test('falls back to session_id when thread_id is absent (codex)', async () => {
    const env = await isolatedEnv()
    const payload = JSON.stringify({ session_id: 'codex-sess-1' })
    const result = await ensureGuestForProviderSession('codex', payload, { env })

    expect(result.created).toBe(true)
    expect(result.record!.cache?.provider_session_id).toBe('codex-sess-1')
  })

  test('returns created:false when session_id is missing in payload', async () => {
    const env = await isolatedEnv()
    const payload = JSON.stringify({ some_other_field: 'value' })
    const result = await ensureGuestForProviderSession('claude-code', payload, { env })

    expect(result.created).toBe(false)
    expect(result.record).toBeNull()
  })

  test('returns created:false for empty/invalid payload', async () => {
    const env = await isolatedEnv()
    const result = await ensureGuestForProviderSession('claude-code', '', { env })
    expect(result.created).toBe(false)
    expect(result.record).toBeNull()
  })

  test('returns created:false and existing record when session already bound', async () => {
    const env = await isolatedEnv()
    const payload = JSON.stringify({ session_id: 'sess-dup' })

    // First call creates the guest
    const first = await ensureGuestForProviderSession('claude-code', payload, { env })
    expect(first.created).toBe(true)

    // Second call with the same session id should be a no-op (idempotency)
    const second = await ensureGuestForProviderSession('claude-code', payload, { env })
    expect(second.created).toBe(false)
    // 同一条会话只该有一条记录 —— 幂等的判据是「没长出第二条」,不是两个句柄相等。
    expect(second.record!.created_at).toBe(first.record!.created_at)
    const roster = await listAgents(env, { includeGuests: true })
    expect(roster.filter((a) => a.cache?.provider_session_id === 'sess-dup')).toHaveLength(1)
  })

  test('the guest record is found by matchAgentBySessionId (idempotency check relies on this)', async () => {
    const env = await isolatedEnv()
    const payload = JSON.stringify({ session_id: 'sess-lookup' })
    await ensureGuestForProviderSession('claude-code', payload, { env })

    const found = await matchAgentByProviderSessionId('sess-lookup', env)
    expect(found).not.toBeNull()
    expect(found!.status).toBe('guest')
  })

  test('guest name avoids engine keyword basenames', async () => {
    const env = await isolatedEnv()
    const payload = JSON.stringify({ session_id: 'sess-eng' })
    const result = await ensureGuestForProviderSession('claude-code', payload, { env, cwd: '/home/user/claude' })

    expect(result.created).toBe(true)
    // Name must not start with 'claude'
    expect(result.record!.name.startsWith('claude')).toBe(false)
    expect(result.record!.name.startsWith('project')).toBe(true)
  })

  test('guest name falls back to project for non-ASCII (dashes-only after sanitize)', async () => {
    const env = await isolatedEnv()
    const payload = JSON.stringify({ session_id: 'sess-cjk' })
    // Chinese directory name sanitizes to all dashes
    const result = await ensureGuestForProviderSession('claude-code', payload, { env, cwd: '/home/user/我的项目' })

    expect(result.created).toBe(true)
    expect(result.record!.name.startsWith('project')).toBe(true)
  })

  test('never throws — bad JSON payload returns created:false', async () => {
    const env = await isolatedEnv()
    const result = await ensureGuestForProviderSession('claude-code', 'not-json!!{{{', { env })
    expect(result.created).toBe(false)
    expect(result.record).toBeNull()
  })

  test('does not bind already-registered (non-guest) agent', async () => {
    const env = await isolatedEnv()
    // Create a real (non-guest) agent bound to the same session
    await createAgent(
      { name: 'Existing', agent_type: 'claude-code', path: '/p', gugu_user_id: 'usr-1' },
      env
    )
    await updateAgent({ guguUserId: 'usr-1' }, { cache: { provider_session_id: 'sess-existing' } }, env)

    const payload = JSON.stringify({ session_id: 'sess-existing' })
    const result = await ensureGuestForProviderSession('claude-code', payload, { env })

    expect(result.created).toBe(false)
    expect(result.record!.gugu_user_id).toBe('usr-1')
    // The real agent is returned as-is (no duplication)
    const all = await listAgents(env)
    expect(all.filter((a) => a.cache?.provider_session_id === 'sess-existing')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// isGuestAgentRecord
// ---------------------------------------------------------------------------

describe('isGuestAgentRecord', () => {
  test('returns true for a guest record (status=guest, no gugu_user_id)', async () => {
    const env = await isolatedEnv()
    const payload = JSON.stringify({ session_id: 'sess-isgr-1' })
    const { record } = await ensureGuestForProviderSession('claude-code', payload, { env })
    expect(isGuestAgentRecord(record!)).toBe(true)
  })

  test('returns false for an active agent (has gugu_user_id)', async () => {
    const env = await isolatedEnv()
    const agent = await createAgent(
      { name: 'Active', agent_type: 'claude-code', path: '/p', gugu_user_id: 'usr-active', status: 'active' },
      env
    )
    expect(isGuestAgentRecord(agent)).toBe(false)
  })

  test('returns false for an agent with gugu_user_id even if status is guest', async () => {
    const env = await isolatedEnv()
    const agent = await createAgent(
      { name: 'Weird', agent_type: 'claude-code', path: '/p', gugu_user_id: 'usr-weird', status: 'guest' },
      env
    )
    expect(isGuestAgentRecord(agent)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// resolveAgentRuntimeSessionIdentity — guest records are invisible to the ladder
// ---------------------------------------------------------------------------

describe('resolveAgentRuntimeSessionIdentity — guest invisibility', () => {
  test('rung 2: guest record bound to session id does NOT resolve to an identity', async () => {
    const env = await isolatedEnv()
    const providerSessionId = 'sess-invisible-rung2'
    const payload = JSON.stringify({ session_id: providerSessionId })
    await ensureGuestForProviderSession('claude-code', payload, { env })

    // Simulate the session env the hook would see
    const sessionEnv = { ...env, CLAUDE_CODE_SESSION_ID: providerSessionId }
    const { identity } = await resolveAgentRuntimeSessionIdentity(sessionEnv)

    expect(identity).toBeNull()
  })

  // 原「rung 1 指向 guest 也不解析」已随 rung 1(GUGU_LOCAL_ID)一起撤销。它真正在守的不变量还在:
  // guest 对身份阶梯不可见 —— 现在唯一的入口是 provider 会话 id,所以直接从那条路验。
  test('a guest stays invisible to the ladder even when its own session id is present', async () => {
    const env = await isolatedEnv()
    const payload = JSON.stringify({ session_id: 'sess-invisible-rung1' })
    const { record } = await ensureGuestForProviderSession('claude-code', payload, { env })
    expect(isGuestAgentRecord(record!)).toBe(true)

    const { identity } = await resolveAgentRuntimeSessionIdentity({
      ...env,
      CLAUDE_CODE_SESSION_ID: 'sess-invisible-rung1',
    })
    expect(identity).toBeNull()
  })

  test('after activation (status→active), the ladder resolves the record normally', async () => {
    const env = await isolatedEnv()
    const providerSessionId = 'sess-post-activate'

    // Create a guest then manually promote it (simulate activateGuestAgent outcome)
    const payload = JSON.stringify({ session_id: providerSessionId })
    await ensureGuestForProviderSession('claude-code', payload, { env })
    const agentUserId = 'usr-post-activate-001'
    await updateAgent({ providerSessionId }, { gugu_user_id: agentUserId, status: 'active' }, env)

    const sessionEnv = { ...env, CLAUDE_CODE_SESSION_ID: providerSessionId }
    const { identity } = await resolveAgentRuntimeSessionIdentity(sessionEnv)

    expect(identity).not.toBeNull()
    expect(identity!.agentUserId).toBe(agentUserId)
  })
})

// ---------------------------------------------------------------------------
// Fix 1a: matchAgentBySessionId prefers non-guest over guest for same session
// ---------------------------------------------------------------------------

describe('matchAgentBySessionId — non-guest preference', () => {
  test('returns registered (non-guest) record when both exist for same session id', async () => {
    const env = await isolatedEnv()
    const providerSessionId = 'sess-pref-test'

    // Create guest first
    await ensureGuestForProviderSession('claude-code', JSON.stringify({ session_id: providerSessionId }), { env })

    // Then create a registered (non-guest) agent for the same session
    await createAgent(
      { name: 'MyAgent', agent_type: 'claude-code', path: '/p', gugu_user_id: 'usr-123', status: 'active' },
      env
    )
    await updateAgent({ guguUserId: 'usr-123' }, { cache: { provider_session_id: providerSessionId } }, env)

    const found = await matchAgentByProviderSessionId(providerSessionId, env)
    expect(found).not.toBeNull()
    expect(found!.gugu_user_id).toBe('usr-123')
    expect(isGuestAgentRecord(found!)).toBe(false)
  })

  test('returns guest when no non-guest is bound to that session', async () => {
    const env = await isolatedEnv()
    const providerSessionId = 'sess-guest-only'
    await ensureGuestForProviderSession('claude-code', JSON.stringify({ session_id: providerSessionId }), { env })

    const found = await matchAgentByProviderSessionId(providerSessionId, env)
    expect(found).not.toBeNull()
    expect(isGuestAgentRecord(found!)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Fix 1b: register cleanup — guest bound to session removed after register
// ---------------------------------------------------------------------------

describe('register cleanup', () => {
  test('removes guest record with same session id after explicit register', async () => {
    const env = await isolatedEnv()
    const providerSessionId = 'sess-reg-cleanup'

    // Session-start hook creates guest
    await ensureGuestForProviderSession('claude-code', JSON.stringify({ session_id: providerSessionId }), { env })

    // Simulate register: create real agent + remove guest (as commands.ts register flow does)
    await createAgent(
      { name: 'Registered', agent_type: 'claude-code', path: '/p', gugu_user_id: 'usr-reg', status: 'active' },
      env
    )
    await updateAgent({ guguUserId: 'usr-reg' }, { cache: { provider_session_id: providerSessionId } }, env)

    // Execute the cleanup logic (mirrors commands.ts register post-step)
    await removeAgents(
      (candidate) =>
        isGuestAgentRecord(candidate) && candidate.cache?.provider_session_id === providerSessionId,
      env,
    )

    // Only registered record should remain for this session
    const remaining = await matchAgentByProviderSessionId(providerSessionId, env)
    expect(remaining).not.toBeNull()
    expect(remaining!.gugu_user_id).toBe('usr-reg')

    // No guest records left
    const guests = (await listAgents(env, { includeGuests: true })).filter(isGuestAgentRecord)
    expect(guests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Fix 4: createGuestAgentForSession — atomic idempotency
// ---------------------------------------------------------------------------

describe('createGuestAgentForSession', () => {
  test('creates record with session id bound in one write', async () => {
    const env = await isolatedEnv()
    const result = await createGuestAgentForProviderSession(
      { name: 'my-proj-ab12', agent_type: 'claude-code', path: '/work', providerSessionId: 'sess-atomic-1' },
      env
    )
    expect(result.created).toBe(true)
    expect(result.record.status).toBe('guest')
    expect(result.record.gugu_user_id).toBe('')
    expect(result.record.cache?.provider_session_id).toBe('sess-atomic-1')
  })

  test('second call with same session id returns created:false and existing record', async () => {
    const env = await isolatedEnv()
    const first = await createGuestAgentForProviderSession(
      { name: 'proj-first', agent_type: 'claude-code', providerSessionId: 'sess-idem' },
      env
    )
    const second = await createGuestAgentForProviderSession(
      { name: 'proj-second', agent_type: 'claude-code', providerSessionId: 'sess-idem' },
      env
    )
    expect(second.created).toBe(false)
    expect(second.record.created_at).toBe(first.record.created_at)

    // Only one record in the store
    const all = await listAgents(env, { includeGuests: true })
    expect(all.filter((a) => a.cache?.provider_session_id === 'sess-idem')).toHaveLength(1)
  })

  test('non-guest record for same session id prevents guest creation', async () => {
    const env = await isolatedEnv()
    await createAgent(
      { name: 'Real', agent_type: 'claude-code', path: '/p', gugu_user_id: 'usr-real' },
      env
    )
    await updateAgent({ guguUserId: 'usr-real' }, { cache: { provider_session_id: 'sess-real-blocks' } }, env)

    const result = await createGuestAgentForProviderSession(
      { name: 'ghost', agent_type: 'claude-code', providerSessionId: 'sess-real-blocks' },
      env
    )
    expect(result.created).toBe(false)
    expect(result.record.gugu_user_id).toBe('usr-real')
  })
})

// ---------------------------------------------------------------------------
// Fix 6: listAgents excludes guests by default; includeGuests:true includes them
// ---------------------------------------------------------------------------

describe('listAgents guest filtering', () => {
  test('excludes guest records by default', async () => {
    const env = await isolatedEnv()
    await ensureGuestForProviderSession('claude-code', JSON.stringify({ session_id: 'sess-g1' }), { env })
    const visible = await listAgents(env)
    expect(visible.every((a) => !isGuestAgentRecord(a))).toBe(true)
  })

  test('includes guest records when includeGuests:true', async () => {
    const env = await isolatedEnv()
    await ensureGuestForProviderSession('claude-code', JSON.stringify({ session_id: 'sess-g2' }), { env })
    const all = await listAgents(env, { includeGuests: true })
    expect(all.some(isGuestAgentRecord)).toBe(true)
  })

  test('non-guest agents are always visible in both modes', async () => {
    const env = await isolatedEnv()
    await createAgent(
      { name: 'Real', agent_type: 'claude-code', path: '/p', gugu_user_id: 'usr-vis' },
      env
    )
    const def = await listAgents(env)
    const withGuests = await listAgents(env, { includeGuests: true })
    expect(def.some((a) => a.gugu_user_id === 'usr-vis')).toBe(true)
    expect(withGuests.some((a) => a.gugu_user_id === 'usr-vis')).toBe(true)
  })
})

describe('guest lifecycle public boundary', () => {
  test('guest registration promotion and freeform attachment boundary', async () => {
    vi.stubEnv('GUGU_SUPABASE_URL', 'https://guest-lifecycle.invalid')
    vi.stubEnv('GUGU_SUPABASE_ANON_KEY', 'anon-test-key')

    const concurrentEnv = await isolatedEnv()
    const payload = JSON.stringify({ session_id: 'session-concurrent' })
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensureGuestForProviderSession('claude-code', payload, { env: concurrentEnv, cwd: '/work/concurrent' }),
      ),
    )
    expect(concurrent.filter((result) => result.created)).toHaveLength(1)
    expect(
      (await listAgents(concurrentEnv, { includeGuests: true }))
        .filter((a) => a.cache?.provider_session_id === 'session-concurrent'),
    ).toHaveLength(1)
    expect(await listAgents(concurrentEnv)).toEqual([])
    expect(await resolveAgentRuntimeSessionIdentity({
      ...concurrentEnv,
      CLAUDE_CODE_SESSION_ID: 'session-concurrent',
    })).toMatchObject({ identity: null })

    const missingOwnerEnv = await isolatedEnv()
    await ensureGuestForProviderSession(
      'codex',
      JSON.stringify({ thread_id: 'thread-missing-owner' }),
      { env: missingOwnerEnv, cwd: '/work/missing-owner' },
    )
    await expect(activateGuestAgent('thread-missing-owner', { env: missingOwnerEnv })).rejects.toThrow(
      'Not logged in',
    )
    expect((await listAgents(missingOwnerEnv, { includeGuests: true }))[0]).toMatchObject({
      status: 'guest',
      gugu_user_id: '',
    })

    const missingDeviceEnv = await isolatedEnv()
    await ensureGuestForProviderSession(
      'codex',
      JSON.stringify({ thread_id: 'thread-missing-device' }),
      { env: missingDeviceEnv, cwd: '/work/missing-device' },
    )
    await writeHumanAuthSession({
      user_id: 'owner-missing-device',
      email: 'owner-missing-device@example.test',
      access_token: 'owner-access-missing-device',
      refresh_token: 'owner-refresh-missing-device',
      refresh_owner: 'desktop',
      updated_at: '2026-08-01T00:00:00.000Z',
    }, missingDeviceEnv)
    await expect(activateGuestAgent('thread-missing-device', { env: missingDeviceEnv })).rejects.toThrow(
      'Device not registered yet',
    )
    expect((await listAgents(missingDeviceEnv, { includeGuests: true }))[0]).toMatchObject({
      status: 'guest',
      gugu_user_id: '',
    })

    const provisionFailureEnv = await isolatedEnv()
    await ensureGuestForProviderSession(
      'claude-code',
      JSON.stringify({ session_id: 'session-provision-failure' }),
      { env: provisionFailureEnv, cwd: '/work/provision-failure' },
    )
    await writeHumanAuthSession({
      user_id: 'owner-provision-failure',
      email: null,
      access_token: 'owner-access-provision-failure',
      refresh_token: 'owner-refresh-provision-failure',
      refresh_owner: 'desktop',
      updated_at: '2026-08-01T00:00:00.000Z',
    }, provisionFailureEnv)
    await writeDeviceIdCache(deviceFile(provisionFailureEnv, 'owner-provision-failure'), 'device-provision-failure')
    await expect(activateGuestAgent('session-provision-failure', {
      env: provisionFailureEnv,
      fetchImpl: async () => new Response('provision rejected', { status: 503 }),
    })).rejects.toThrow('create_owned_agent failed (503)')
    expect((await listAgents(provisionFailureEnv, { includeGuests: true }))[0]).toMatchObject({
      status: 'guest',
      gugu_user_id: '',
    })
    expect(await readAgentRuntimeSession('agent-provision-failure', provisionFailureEnv)).toBeNull()

    const successEnv = await isolatedEnv()
    const successGuest = await ensureGuestForProviderSession(
      'codex',
      JSON.stringify({ thread_id: 'thread-success' }),
      { env: successEnv, cwd: '/work/success' },
    )
    await writeHumanAuthSession({
      user_id: 'owner-success',
      email: 'owner-success@example.test',
      access_token: 'owner-access-v1',
      refresh_token: 'owner-refresh-v1',
      refresh_owner: 'desktop',
      updated_at: '2026-08-01T00:00:00.000Z',
    }, successEnv)
    await writeDeviceIdCache(deviceFile(successEnv, 'owner-success'), 'device-success')
    const provisionCalls: Array<{ url: string; init: RequestInit }> = []
    const provisionFetch: typeof fetch = async (input, init) => {
      provisionCalls.push({ url: String(input), init: init ?? {} })
      return new Response(JSON.stringify([{
        id: 'agent-success',
        display_name: 'Promoted Guest',
        avatar: null,
        created_at: '2026-08-01T00:00:00.000Z',
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const promoted = await activateGuestAgent('thread-success', {
      env: successEnv,
      cwd: '/work/success',
      displayName: 'Promoted Guest',
      fetchImpl: provisionFetch,
    })
    expect(promoted).toEqual({ name: successGuest.record!.name, agentUserId: 'agent-success' })
    expect(provisionCalls).toHaveLength(1)
    expect(provisionCalls[0].url).toBe('https://guest-lifecycle.invalid/rest/v1/rpc/create_owned_agent')
    expect(provisionCalls[0].init.headers).toMatchObject({
      Authorization: 'Bearer owner-access-v1',
      apikey: 'anon-test-key',
    })
    expect(JSON.parse(String(provisionCalls[0].init.body))).toMatchObject({
      p_display_name: 'Promoted Guest',
      p_agent_type: 'codex',
      p_device_id: 'device-success',
      p_local_path: '/work/success',
    })
    expect((await listAgents(successEnv, { includeGuests: true }))[0]).toMatchObject({
      status: 'active',
      gugu_user_id: 'agent-success',
    })
    expect(await readAgentRuntimeSession('agent-success', successEnv)).toMatchObject({
      accessToken: 'owner-access-v1',
      refreshToken: 'owner-refresh-v1',
      agentUserId: 'agent-success',
    })

    const repeated = await activateGuestAgent('thread-success', {
      env: successEnv,
      fetchImpl: async () => { throw new Error('must not reprovision') },
    })
    expect(repeated).toEqual({ name: successGuest.record!.name, agentUserId: 'agent-success' })
    expect(provisionCalls).toHaveLength(1)

    await writeHumanAuthSession({
      user_id: 'owner-success',
      email: 'owner-success@example.test',
      access_token: 'owner-access-v2',
      refresh_token: 'owner-refresh-v2',
      refresh_owner: 'desktop',
      updated_at: '2026-08-01T00:01:00.000Z',
    }, successEnv)
    expect(await attachFreeformAgent({ guguUserId: 'agent-success' }, {
      env: successEnv,
      cwd: '/work/reattached',
    })).toEqual({
      agentUserId: 'agent-success',
      runtime: 'codex',
      cwd: '/work/reattached',
    })
    expect(await readAgentRuntimeSession('agent-success', successEnv)).toMatchObject({
      accessToken: 'owner-access-v2',
      refreshToken: 'owner-refresh-v2',
    })
    await expect(attachFreeformAgent({ guguUserId: 'missing-agent' }, { env: successEnv })).rejects.toThrow('No such local agent')

    const activeWithoutOwnerEnv = await isolatedEnv()
    await createAgent({
      name: 'Active without owner auth',
      agent_type: 'codex',
      path: '/work/active-without-owner',
      gugu_user_id: 'agent-active-without-owner',
      status: 'active',
    }, activeWithoutOwnerEnv)
    await expect(attachFreeformAgent({ guguUserId: 'agent-active-without-owner' }, { env: activeWithoutOwnerEnv })).rejects.toThrow(
      'Not logged in',
    )
    expect(await readAgentRuntimeSession('agent-active-without-owner', activeWithoutOwnerEnv)).toBeNull()

    await expect(
      attachFreeformAgent({ providerSessionId: 'thread-missing-owner' }, { env: missingOwnerEnv }),
    ).rejects.toThrow('has no gugu_user_id')
  })
})
