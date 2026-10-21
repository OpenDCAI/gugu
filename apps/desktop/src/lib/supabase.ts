import { createGuguSupabaseClient, type GuguSupabaseStorage } from '@gugu/core/cloud/supabase'
import { Capacitor, registerPlugin } from '@capacitor/core'
import type { Session } from '@supabase/supabase-js'
import { authBoundedFetch } from './authBoundedFetch'
import { getRendererAccessToken, getRendererSession } from './sessionPublication'

export const MAIN_AUTH_STORAGE_KEY = 'sb-main'
const mainAuthStorage = window.localStorage
type NativeAuthStorage = {
  get(options: { key: string }): Promise<{ value: string | null }>
  write(options: { key: string; value: string }): Promise<void>
}
const nativeAuthStorage = registerPlugin<NativeAuthStorage>('GuguAuthStorage')
let storageTail = Promise.resolve()
const webBootRaw = Capacitor.isNativePlatform() ? null : mainAuthStorage.getItem(MAIN_AUTH_STORAGE_KEY)
let bootCandidate = webBootRaw ? readStoredSession(webBootRaw) : null
let legacyCleanup: string | false | null = null

function readStoredSession(raw: string): Session {
  const value = JSON.parse(raw) as Partial<Session>
  if (![value.access_token, value.refresh_token, value.user?.id].every((part) => typeof part === 'string' && part.length > 0)) throw new Error('Malformed persisted auth session')
  return value as Session
}
const sameSession = (left: Session, right: Session): boolean =>
  left.user.id === right.user.id && left.access_token === right.access_token && left.refresh_token === right.refresh_token

function ordered<T>(work: () => Promise<T>): Promise<T> {
  const result = storageTail.then(work)
  storageTail = result.then(() => undefined, () => undefined)
  return result
}
function readEnvelope(raw: string): { raw: string | null; session: Session | null } {
  const envelope = JSON.parse(raw) as Record<string, unknown>
  const keys = Object.keys(envelope)
  if (envelope.state === 'RETIRED_EMPTY' && keys.length === 1) return { raw: null, session: null }
  if (envelope.state !== 'SESSION' || keys.length !== 2 || typeof envelope.raw !== 'string')
    throw new Error('Malformed native auth envelope')
  return { raw: envelope.raw, session: readStoredSession(envelope.raw) }
}
function cleanLegacyStorage(observed?: string): void {
  try {
    const raw = observed ?? (typeof legacyCleanup === 'string' ? legacyCleanup : mainAuthStorage.getItem(MAIN_AUTH_STORAGE_KEY))
    if (raw === null) { legacyCleanup = null; return }
    legacyCleanup = raw
    if (mainAuthStorage.getItem(MAIN_AUTH_STORAGE_KEY) !== raw) return
    mainAuthStorage.removeItem(MAIN_AUTH_STORAGE_KEY)
    legacyCleanup = null
  } catch { if (legacyCleanup === null) legacyCleanup = false }
}
async function readNativeStorage(): Promise<string | null> {
  const result = await nativeAuthStorage.get({ key: MAIN_AUTH_STORAGE_KEY })
  if (result.value === null) {
    const legacy = mainAuthStorage.getItem(MAIN_AUTH_STORAGE_KEY)
    if (legacy !== null) {
      const candidate = readStoredSession(legacy)
      await nativeAuthStorage.write({ key: MAIN_AUTH_STORAGE_KEY, value: JSON.stringify({ state: 'SESSION', raw: legacy }) }).then(() => { bootCandidate = candidate })
      cleanLegacyStorage(legacy)
      return legacy
    }
    await nativeAuthStorage.write({ key: MAIN_AUTH_STORAGE_KEY, value: JSON.stringify({ state: 'RETIRED_EMPTY' }) }).then(() => { bootCandidate = readEnvelope(JSON.stringify({ state: 'RETIRED_EMPTY' })).session })
    return null
  }
  const projected = readEnvelope(result.value)
  bootCandidate = projected.session
  cleanLegacyStorage()
  return projected.raw
}

export const mainAuthSessionStorage = {
  storage: {
    getItem: (key) => key !== MAIN_AUTH_STORAGE_KEY ? null : Capacitor.isNativePlatform() ? ordered(readNativeStorage) : mainAuthStorage.getItem(MAIN_AUTH_STORAGE_KEY),
    setItem: () => {},
    removeItem: () => {},
  } satisfies GuguSupabaseStorage,
  getState: () => ({ bootCandidate, warning: legacyCleanup === null ? null : new Error('Legacy auth storage cleanup pending') }),
  commit(session: Session, signal: AbortSignal): Promise<void> {
    return ordered(async () => {
      if (signal.aborted) return
      const raw = JSON.stringify(session)
      if (Capacitor.isNativePlatform()) {
        await nativeAuthStorage.write({ key: MAIN_AUTH_STORAGE_KEY, value: JSON.stringify({ state: 'SESSION', raw }) })
        cleanLegacyStorage()
      } else mainAuthStorage.setItem(MAIN_AUTH_STORAGE_KEY, raw)
      bootCandidate = session
    })
  },
  remove(session: Session, signal: AbortSignal): Promise<void> {
    return ordered(async () => {
      if (signal.aborted) return
      if (Capacitor.isNativePlatform()) {
        const result = await nativeAuthStorage.get({ key: MAIN_AUTH_STORAGE_KEY })
        if (result.value === null) throw new Error('Native auth storage is uninitialized during cleanup')
        const current = readEnvelope(result.value)
        if (current.session && !sameSession(current.session, session)) throw new Error('Persisted auth session changed before cleanup')
        if (current.session) await nativeAuthStorage.write({ key: MAIN_AUTH_STORAGE_KEY, value: JSON.stringify({ state: 'RETIRED_EMPTY' }) })
        cleanLegacyStorage()
      } else {
        const raw = mainAuthStorage.getItem(MAIN_AUTH_STORAGE_KEY)
        if (raw && !sameSession(readStoredSession(raw), session)) throw new Error('Persisted auth session changed before cleanup')
        mainAuthStorage.removeItem(MAIN_AUTH_STORAGE_KEY)
      }
      bootCandidate = null
    })
  },
}

// @@@single-refresher (#6723) — 一个会话只有一个刷新者:sessionCoordinator。这个客户端只做 auth,
// 类型上也只露出 `.auth`。数据请求(PostgREST / storage / functions / realtime)不经过它:auth-js 每次请求前
// 都 getSession(),离到期不足 90s 就自己刷新;而上面的 storage 是 no-op、协调器也不采纳它的 TOKEN_REFRESHED
// ⇒ 刷新结果被扔掉,下一个请求拿同一个旧 refresh token 再刷一次。数据请求一律走下面按 `accessToken`
// 读协调器已发布令牌的客户端 —— 它们没有自己的 auth 会话,也就不会刷新。
const mainAccessToken = async (): Promise<string | null> => getRendererAccessToken()

const authClient = createGuguSupabaseClient({
  storage: mainAuthSessionStorage.storage,
  storageKey: MAIN_AUTH_STORAGE_KEY,
  persistSession: true,
  autoRefreshToken: false,
  fetch: authBoundedFetch,
  // supabase-js 收到 SIGNED_OUT 就 realtime.setAuth(),它默认的取令牌回调是 auth.getSession() —— 一次刷新失败
  // 发出的 SIGNED_OUT 会让它从上面那份删不掉的存储里再刷一次,失败再签出,自己转圈(#6723)。这里的 realtime
  // 与数据客户端一样只读协调器已发布的令牌。
  realtime: { accessToken: mainAccessToken },
})
export const supabase: Pick<typeof authClient, 'auth'> = authClient

export const dataClient = createGuguSupabaseClient({
  accessToken: mainAccessToken,
  fetch: authBoundedFetch,
})

export const chatDb = createGuguSupabaseClient({
  schema: 'chat',
  accessToken: mainAccessToken,
  fetch: authBoundedFetch,
})
export const identityDb = createGuguSupabaseClient({
  schema: 'identity',
  accessToken: mainAccessToken,
  fetch: authBoundedFetch,
})

export async function getCurrentAuthUserId(): Promise<string> {
  const userId = getRendererSession()?.user.id
  if (!userId) throw new Error('Not authenticated')
  return userId
}

// #2115 — 失败条「重试」：把终态 error 的 agent.deliver 命令 CAS 回 pending（清 error/认领/完成痕迹），
// 设备重新认领、全链路（listen-mode 门/投递 claim/bootstrap）原样重走 = 真重投递，非假按钮。
// ⚠️ 这是一次 UPDATE:`command_created` 广播只挂在 INSERT 上,设备宿主也不再轮询(#5906)⇒ **调用方**必须在成功后
//    `platform.notifyDeviceCommandsChanged?.()`,否则这条行要等下一个对账节拍才被取走。
// CAS 语义：status 条件不满足（命令已被别处改走）→ 返回 false，调用方
// 放弃本次重试，不盲改。owner RLS 允许更新这些列（migration 030，与 #2145 同一权限面）。
export async function requeueErroredDeviceCommand(commandId: string): Promise<boolean> {
  const { data, error } = await identityDb
    .from('gugu_device_commands')
    .update({ status: 'pending', error: null, claimed_at: null, claimed_by: null, claim_token: null, completed_at: null })
    .eq('id', commandId)
    .eq('status', 'error')
    .select('id')
  if (error) throw new Error(error.message)
  return (data ?? []).length > 0
}
