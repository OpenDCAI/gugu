import { useEffect, useSyncExternalStore } from 'react'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { identityDb } from './supabase'
import { rendererLogger } from './log'
import { pickAssistant, type AssistantProvisionRow } from './assistantProvision'
import { useAuth } from '../store/auth'
import type { ContactsLoadStatus } from '../store/contactsContext'

export type MyAssistantState = {
  agentId: string | null
  /** 库里那一行记的是哪台(建它 / 最近一次搬过去的);它此刻住哪以通讯录为准,见 `useMyAssistantContact`。 */
  provisionDeviceId: string | null
  loading: boolean
  error: string | null
}

const log = rendererLogger('assistant/identity')
const LOADING: MyAssistantState = { agentId: null, provisionDeviceId: null, loading: true, error: null }
const NONE: MyAssistantState = { agentId: null, provisionDeviceId: null, loading: false, error: null }
const states = new Map<string, MyAssistantState>()
const inflight = new Set<string>()
const reloadPending = new Set<string>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of [...listeners]) listener()
}

async function load(ownerUserId: string) {
  if (inflight.has(ownerUserId)) return
  inflight.add(ownerUserId)
  try {
    const { data, error } = await identityDb
      .from('agent_provisions')
      .select('agent_user_id, device_id, member_key, phase, created_at')
      .eq('member_key', 'assistant')
      .eq('owner_user_id', ownerUserId)
    if (error) throw new Error(error.message)
    const pick = pickAssistant((data ?? []) as AssistantProvisionRow[])
    states.set(ownerUserId, { agentId: pick?.agentId ?? null, provisionDeviceId: pick?.deviceId ?? null, loading: false, error: null })
  } catch (error) {
    // 读不到 ≠ 没有助理:如实交出去,由看的一方说「读不到」。
    log.error({ error: String(error) }, 'read assistant provision failed')
    states.set(ownerUserId, { agentId: null, provisionDeviceId: null, loading: false, error: error instanceof Error ? error.message : String(error) })
  } finally {
    inflight.delete(ownerUserId)
    emit()
    // Do not lose a completion signal behind a read started before completion.
    if (reloadPending.delete(ownerUserId)) void load(ownerUserId)
  }
}

/**
 * 这个 agent 是不是他的个人助理(读这里已经读到的那一份,不发请求)。通讯录 / agent 设置里删它时分流用(#7350):
 * 一直挂着的 AssistantCloseHost 在开 App 时就读过;还没读到 = 当它不是,走通用的删除。
 */
export function isMyAssistant(ownerUserId: string | null | undefined, agentUserId: string): boolean {
  return !!ownerUserId && states.get(ownerUserId)?.agentId === agentUserId
}

/** 开通 / 搬家刚落定:那一行才刚写好,马上重读一遍(❌ 等通讯录变了才重读 —— 搬家不增减 agent)。 */
export function reloadMyAssistant(ownerUserId: string | null | undefined): void {
  if (!ownerUserId) return
  if (inflight.has(ownerUserId)) reloadPending.add(ownerUserId)
  else void load(ownerUserId)
}

/**
 * 这个人的个人助理是谁(按库里的标记,不论它住在云上还是哪台电脑上)。`refreshKey` 一变就重读一遍 ——
 * 调用方把「通讯录里他的 agent 变了」当成该重读的信号传进来(开通刚建好它的那一刻)。
 */
export function useMyAssistant(ownerUserId: string | null | undefined, refreshKey: unknown): MyAssistantState {
  const state = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (ownerUserId ? states.get(ownerUserId) ?? LOADING : NONE),
  )
  useEffect(() => {
    reloadMyAssistant(ownerUserId)
  }, [ownerUserId, refreshKey])
  return state
}

/**
 * 壳这一侧(左栏那一格、App 的壳一半、手机)要的是通讯录里的那一位:按标记认出 id,再到通讯录里取头像、名字和它住的那台
 * (`homeDeviceId`:通讯录里它的 `device_id`,搬家落定时改的就是它;通讯录还没跟上时退回库里那一行记的那台)。
 * 第二个参数是旧签名留下的(以前按云电脑过滤),不再用。
 */
export function useMyAssistantContact(contacts: readonly ContactUser[], _legacyCloudDeviceId?: string | null) {
  const { user } = useAuth()
  const ownerUserId = user?.id ?? null
  const mine = contacts
    .filter((c) => c.type === 'agent' && (!c.owner_user_id || c.owner_user_id === ownerUserId))
    .map((c) => `${c.id}@${c.device_id ?? ''}`)
    .join(',')
  const state = useMyAssistant(ownerUserId, mine)
  const contact = state.agentId ? contacts.find((c) => c.id === state.agentId) ?? null : null
  const homeDeviceId = contact?.device_id ?? state.provisionDeviceId
  return { ...state, contact, homeDeviceId }
}

/**
 * 个人助理此刻认到哪一步:库里的标记认出是谁,再到通讯录里取那一位。
 * #7408 认出了是谁、通讯录却没读成(里头没有它):说读不到,❌ 一直「正在读」。
 */
export function assistantIdentityState(
  inContacts: boolean,
  mine: Pick<MyAssistantState, 'agentId' | 'loading' | 'error'>,
  contactsStatus: ContactsLoadStatus,
): 'found' | 'loading' | 'unreadable' | 'none' {
  if (inContacts) return 'found'
  if (mine.loading) return 'loading'
  if (mine.error) return 'unreadable'
  if (mine.agentId) return contactsStatus === 'error' ? 'unreadable' : 'loading'
  return 'none'
}
