#!/usr/bin/env tsx

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const FIXTURE_NAME = 'E2E-OwnedAgent-Fixture'

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for the local web pilot seed`)
  return value
}

function assertLoopback(url: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`local web pilot refuses non-loopback Supabase URL: ${parsed.origin}`)
  }
}

async function findExactAuthUser(
  admin: SupabaseClient,
  email: string
): Promise<{ id: string } | null> {
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`local pilot could not list Auth users: ${error.message}`)
    const found = data.users.find(
      (user) => user.email?.trim().toLowerCase() === email.toLowerCase()
    )
    if (found) return { id: found.id }
    if (data.users.length < 200) return null
  }
  throw new Error('local pilot Auth user list exceeded 20000 rows')
}

async function main(): Promise<void> {
  const url = requiredEnv('GUGU_SUPABASE_URL')
  const anonKey = requiredEnv('GUGU_SUPABASE_ANON_KEY')
  const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  const email = requiredEnv('ALICE_EMAIL')
  const password = requiredEnv('ALICE_PASSWORD')
  const nickname = requiredEnv('ALICE_NICKNAME')
  assertLoopback(url)

  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  })
  if (await findExactAuthUser(admin, email)) {
    throw new Error(`local pilot expected an empty stack, but ${email} already exists`)
  }

  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { nickname, display_name: nickname }
  })
  if (created.error) throw new Error(`local pilot ALICE create failed: ${created.error.message}`)
  const userId = created.data.user?.id
  if (!userId) throw new Error('local pilot ALICE create returned no user id')

  const alice = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  })
  const login = await alice.auth.signInWithPassword({ email, password })
  if (login.error) throw new Error(`local pilot ALICE login failed: ${login.error.message}`)
  if (login.data.user?.id !== userId)
    throw new Error('local pilot ALICE login returned a different user')

  const existingFixture = await alice
    .schema('identity')
    .from('users')
    .select('id')
    .eq('type', 'agent')
    .eq('owner_user_id', userId)
    .eq('display_name', FIXTURE_NAME)
  if (existingFixture.error)
    throw new Error(`local pilot fixture preflight failed: ${existingFixture.error.message}`)
  if ((existingFixture.data ?? []).length !== 0)
    throw new Error('local pilot expected no pre-existing ALICE fixture agent')

  const deviceId = `local-pilot-${userId}`
  const device = await alice.schema('identity').from('gugu_devices').insert({
    device_id: deviceId,
    user_id: userId,
    label: 'local-web-pilot',
    hostname: 'github-hosted',
    platform: 'linux',
    status: 'offline'
  })
  if (device.error) throw new Error(`local pilot ALICE device seed failed: ${device.error.message}`)

  const fixture = await alice.schema('identity').rpc('create_owned_agent', {
    p_display_name: FIXTURE_NAME,
    p_avatar: './assets/agent-avatars/avatar-01.png',
    p_agent_type: 'claude-code',
    p_device_id: deviceId
  })
  if (fixture.error)
    throw new Error(`local pilot owned-agent seed failed: ${fixture.error.message}`)
  const row = Array.isArray(fixture.data) ? fixture.data[0] : fixture.data
  const fixtureId = row?.id as string | undefined
  if (!fixtureId) throw new Error('local pilot owned-agent seed returned no agent id')

  const proof = await alice
    .schema('identity')
    .from('users')
    .select('id,display_name,owner_user_id,type')
    .eq('id', fixtureId)
    .eq('display_name', FIXTURE_NAME)
    .eq('owner_user_id', userId)
    .eq('type', 'agent')
  if (proof.error) throw new Error(`local pilot fixture proof failed: ${proof.error.message}`)
  if ((proof.data ?? []).length !== 1)
    throw new Error('local pilot fixture proof did not find exactly one owned agent')

  const signOut = await alice.auth.signOut({ scope: 'local' })
  if (signOut.error)
    throw new Error(`local pilot ALICE local sign-out failed: ${signOut.error.message}`)
  console.log(
    JSON.stringify({ alice_login: 'ok', owned_agent_fixture_count: 1, fixture_name: FIXTURE_NAME })
  )
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
