/**
 * Service-Layer Integration Tests
 *
 * Runs against the real Supabase project using pre-seeded test users supplied
 * through ALICE_EMAIL / ALICE_PASSWORD. Each run re-logs in and exercises every
 * service layer end-to-end.
 *
 * All supabase clients share the jsdom localStorage, so the session
 * stored by authService.login propagates to service-specific Supabase clients.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { authService, hydrateIdentityAuthUser } from '../../../apps/desktop/src/lib/auth'
import { supabase } from '../../../apps/desktop/src/lib/supabase'
import { publishRendererSession } from '../../../apps/desktop/src/lib/sessionPublication'
import { chatService } from '../../../apps/desktop/src/lib/chat'
import { createChatProjection } from '../../../apps/desktop/src/lib/chatProjection'
import { CHAT_KINDS } from '@gugu/core/shared/enums/chatValueModels'
import { contactsService } from '../../../apps/desktop/src/lib/contacts'
import { loadDotEnvLocal } from '../../../scripts/env-file'

// @@@1170-P3a 产品登录改 OTP-only(authService.login 已删),但测试账号(admin:create-account 建)仍带
// 密码,test setup 直接走 supabase.auth.signInWithPassword API(测试基建,非产品面)登入 ALICE/BOB。
async function loginWithPassword(email: string, password: string): Promise<{ success: boolean; userId?: string; error?: string }> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) return { success: false, error: error.message }
  publishRendererSession('SIGNED_IN', data.session)
  return { success: true, userId: data.user?.id }
}

async function currentIdentityUser() {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw error
  if (!data.user) return null
  return hydrateIdentityAuthUser(data.user, AbortSignal.timeout(15_000))
}

// ── Test fixtures ──────────────────────────────────────────────────────────
const TS = Date.now()

loadDotEnvLocal()

function requiredIntegrationEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for service-layer integration tests`)
  return value
}

const ALICE_EMAIL = requiredIntegrationEnv('ALICE_EMAIL')
const ALICE_PASSWORD = requiredIntegrationEnv('ALICE_PASSWORD')
const ALICE_NICKNAME = requiredIntegrationEnv('ALICE_NICKNAME')

let aliceId = ''

// ── Lifecycle ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  const login = await loginWithPassword(ALICE_EMAIL, ALICE_PASSWORD)
  if (!login.success || !login.userId) {
    throw new Error(
      `beforeAll: failed to login as "${ALICE_EMAIL}" — ${login.error ?? 'unknown error'}`,
    )
  }
  aliceId = login.userId
}, 30_000)

afterAll(async () => {
  try {
    await authService.updateNickname(aliceId, ALICE_NICKNAME)
  } finally {
    await supabase.auth.signOut()
    publishRendererSession('SIGNED_OUT', null)
  }
}, 15_000)

// ── Auth Service ───────────────────────────────────────────────────────────

describe('Auth Service', () => {
  it('login sets aliceId correctly', () => {
    expect(aliceId, 'aliceId should be set after login in beforeAll').toBeTruthy()
    expect(typeof aliceId, 'aliceId should be a string').toBe('string')
  })

  it('getUser returns current user with required fields', async () => {
    const user = await currentIdentityUser()
    expect(user, 'getUser returned null — no active session').not.toBeNull()
    expect(user!.id, 'user.id is empty').toBeTruthy()
    expect(user!.email, 'user.email is empty').toBeTruthy()
    expect(user!.nickname, 'user.nickname is empty').toBeTruthy()
    expect(user!.id, 'user.id does not match login userId').toBe(aliceId)
    expect(user!.email.toLowerCase(), 'user.email mismatch').toBe(ALICE_EMAIL)
  })

  it('updateNickname updates metadata on the auth user', async () => {
    const newNick = `Alice-${TS}`
    const res = await authService.updateNickname(aliceId, newNick)
    expect(res.success, `updateNickname failed: ${res.error}`).toBe(true)

    const user = await currentIdentityUser()
    expect(user!.nickname, 'nickname was not updated').toBe(newNick)
  })

  it('login with wrong password returns failure with error message', async () => {
    const res = await loginWithPassword(ALICE_EMAIL, 'WrongPassword999!')
    expect(res.success, 'login should have failed for wrong password').toBe(false)
    expect(res.error, 'error message is missing on failed login').toBeTruthy()
  })

  it('logout returns success and re-login works', async () => {
    const { error } = await supabase.auth.signOut()
    expect(error, 'logout returned failure').toBeNull()
    publishRendererSession('SIGNED_OUT', null)

    // Re-login for subsequent test groups
    const reLogin = await loginWithPassword(ALICE_EMAIL, ALICE_PASSWORD)
    expect(reLogin.success, `re-login after logout failed: ${reLogin.error}`).toBe(true)
    expect(reLogin.userId, 're-login userId mismatch').toBe(aliceId)
  })
})

// ── Chat Service ───────────────────────────────────────────────────────────

describe('Chat Service', () => {
  // 会话列表的取数属主是投影(spec I7);`chatService.getChats` 那条 8 波串行链已删。
  // 这一格守的面没变:对真库拉一次列表,拿回的每一行形状合法。
  it('the chat-list projection hydrates to an array (may be empty for new user)', async () => {
    const chats = await createChatProjection(aliceId).hydrate('0', new AbortController().signal)
    expect(Array.isArray(chats), 'hydrate should return an array').toBe(true)
    // Each chat item should have required fields if there are any
    for (const chat of chats) {
      expect(chat.id, 'chat.id is missing').toBeTruthy()
      expect(chat.kind, 'chat.kind is missing').toBeTruthy()
      expect(CHAT_KINDS, `unexpected chat.kind: ${chat.kind}`).toContain(chat.kind)
      expect(typeof chat.unread_count, 'chat.unread_count should be a number').toBe('number')
    }
  })

  it('manages an owned agent through the group collaboration flow', async () => {
    const agentName = `E2E Agent ${TS}`
    const peerAgentName = `E2E Peer Agent ${TS}`
    const reserveAgentName = `E2E Reserve Agent ${TS}`
    const groupName = `E2E Agent Group ${TS}`
    const devices = await chatService.listDevices()
    if (devices.length === 0) {
      console.warn('Skipping owned-agent test: no gugu_devices for current user')
      return
    }
    const deviceId = devices[0].device_id
    const agent = await chatService.createOwnedAgent(agentName, { deviceId })
    const peerAgent = await chatService.createOwnedAgent(peerAgentName, { deviceId })
    const reserveAgent = await chatService.createOwnedAgent(reserveAgentName, { deviceId })
    expect(agent.id, 'created agent id is missing').toBeTruthy()
    expect(peerAgent.id, 'created peer agent id is missing').toBeTruthy()
    expect(reserveAgent.id, 'created reserve agent id is missing').toBeTruthy()

    const chatId = await chatService.createGroupChat(groupName, aliceId, [
      agent.id,
      peerAgent.id,
      reserveAgent.id,
    ])
    expect(chatId, 'created group chat id is missing').toBeTruthy()

    let snapshot = (await chatService.getGroupCollab(chatId)).snapshot
    let joined = snapshot.agents.find((item) => item.id === agent.id)
    expect(joined, 'agent was not visible in group collab snapshot after group creation').toBeTruthy()
    expect(joined!.role, 'agent should join as member').toBe('member')

    await chatService.setGroupAgentRole(chatId, agent.id, 'admin')
    snapshot = (await chatService.getGroupCollab(chatId)).snapshot
    joined = snapshot.agents.find((item) => item.id === agent.id)
    expect(joined?.role, 'agent role should update to admin').toBe('admin')

    const messageId = crypto.randomUUID()
    await chatService.sendMessage(chatId, aliceId, `ping ${agentName}`, messageId, 'text', { toUserIds: [agent.id] })
    const messages = await chatService.getMessages(chatId, aliceId, 'other')
    const directed = messages.find((message) => message.id === messageId)
    expect(directed?.to_user_ids, 'directed message should target the agent user id').toEqual([agent.id])

    await chatService.removeGroupMember(chatId, agent.id, true)
    snapshot = (await chatService.getGroupCollab(chatId)).snapshot
    expect(snapshot.agents.some((item) => item.id === agent.id), 'agent should be removed from group').toBe(false)

    await chatService.archiveChat(chatId)
  }, 30_000)

  it('creates a group with one invited agent member through the service path', async () => {
    const agentName = `E2E Single Member Agent ${TS}`
    const groupName = `E2E Single Member Group ${TS}`
    const devices = await chatService.listDevices()
    if (devices.length === 0) {
      console.warn('Skipping one-member group test: no gugu_devices for current user')
      return
    }

    const agent = await chatService.createOwnedAgent(agentName, { deviceId: devices[0].device_id })
    const chatId = await chatService.createGroupChat(groupName, aliceId, [agent.id])

    const { snapshot } = await chatService.getGroupCollab(chatId)
    expect(snapshot.agents.some((item) => item.id === agent.id), 'agent should join one-invited-member group').toBe(true)

    await chatService.archiveChat(chatId)
  }, 30_000)
})

// ── Contacts Service ───────────────────────────────────────────────────────

describe('Contacts Service', () => {
  it('getContacts returns an array (may be empty for new user)', async () => {
    const contacts = await contactsService.getContacts(aliceId)
    expect(Array.isArray(contacts), 'getContacts should return an array').toBe(true)
  })

  it('searchUsers with a query returns an array', async () => {
    const results = await contactsService.searchUsers('alice', aliceId)
    expect(Array.isArray(results), 'searchUsers should return an array').toBe(true)
    // Results should NOT contain the current user
    const selfInResults = results.some((u) => u.id === aliceId)
    expect(selfInResults, 'searchUsers should exclude the current user').toBe(false)
  })

  it('searchUsers with empty string returns empty array', async () => {
    const results = await contactsService.searchUsers('', aliceId)
    expect(results, 'empty query should return []').toEqual([])
  })
})
