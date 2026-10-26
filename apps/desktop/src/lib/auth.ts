import { dbPayload } from '@gugu/core/cloud/supabase'
import type { Session, User } from '@supabase/supabase-js'
import { dataClient, identityDb, supabase } from './supabase'
import { clearPendingReferrer, consumePendingReferrer } from './referral'
import { userVisibleAuthError } from './authErrors'
import { rendererLogger } from './log'
import { i18n } from '@/i18n'
import { readDisplayIdentities } from './identityReadAdapter'

const authLog = rendererLogger('auth/otp')

export interface AuthUser {
  id: string
  gugu_number?: number | null
  email: string
  nickname: string
  avatarUrl?: string
  bio?: string | null
  onboardedAt?: string | null
}

export interface AuthResult {
  success: boolean
  userId?: string
  session?: Session
  error?: string
}

type IdentityUserProfilePatch = {
  display_name?: string
  avatar?: string
  bio?: string | null
}

async function updateIdentityUserProfile(userId: string, patch: IdentityUserProfilePatch): Promise<string | null> {
  const { error } = await identityDb
    .from('users')
    .update(dbPayload(patch))
    .eq('id', userId)
  return error?.message ?? null
}

export async function hydrateIdentityAuthUser(user: User, signal: AbortSignal): Promise<AuthUser | null> {
  const [identityUser] = await readDisplayIdentities([user.id], signal)
  if (!identityUser) return null
  return {
    id: user.id,
    gugu_number: identityUser.gugu_number,
    email: user.email ?? '',
    nickname: identityUser.display_name,
    avatarUrl: identityUser.avatar ?? undefined,
    bio: identityUser.bio,
  }
}

export const authService = {
  async requestLoginOtp(email: string): Promise<AuthResult> {
    const nickname = email.split('@')[0] || 'User'
    const data: Record<string, unknown> = { nickname, display_name: nickname }
    const referrer = consumePendingReferrer()
    if (referrer) data.referrer_gugu_number = referrer
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true, data }
      })
      if (error)
        return { success: false, error: userVisibleAuthError(error) }
      return { success: true }
    } catch (error) {
      authLog.error(
        { error: error instanceof Error ? error.message : String(error) },
        'request login OTP failed',
      )
      return { success: false, error: userVisibleAuthError(error) }
    }
  },

  async verifyLoginOtp(email: string, token: string): Promise<AuthResult> {
    try {
      const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email' })
      if (error) return { success: false, error: userVisibleAuthError(error) }
      clearPendingReferrer()  // @@@1511 登录/注册成功,清掉已用的邀请码(防误带给后续本机登录者)。
      if (!data.session) return { success: false, error: i18n.t('auth.verifyFailed', { ns: 'main' }) }
      return { success: true, userId: data.user?.id, session: data.session }
    } catch (error) {
      authLog.error(
        { error: error instanceof Error ? error.message : String(error) },
        'verify login OTP failed',
      )
      return { success: false, error: userVisibleAuthError(error) }
    }
  },

  async updateNickname(userId: string, nickname: string): Promise<{ success: boolean; error?: string }> {
    const { error } = await supabase.auth.updateUser({ data: { nickname } })
    if (error) return { success: false, error: userVisibleAuthError(error) }
    const profileError = await updateIdentityUserProfile(userId, { display_name: nickname })
    if (profileError) return { success: false, error: profileError }
    return { success: true }
  },

  async updateBio(userId: string, bio: string): Promise<{ success: boolean; error?: string }> {
    const profileError = await updateIdentityUserProfile(userId, { bio: bio.trim() || null })
    if (profileError) return { success: false, error: profileError }
    return { success: true }
  },

  async updateAvatar(userId: string, file: File): Promise<{ success: boolean; avatarUrl?: string; error?: string }> {
    // 每次上传一个新 key(同 agent 头像,contacts.ts 的 uploadOwnedAgentAvatar):URL 一换,缓存里的旧图就冒充不了新图(#6314)。
    // 首段仍是 userId —— 桶的 RLS 与注销清理按它认归属。上一个对象不删:真人改资料还不发账号修订(#6367),
    // 别的客户端在下一次读身份之前手里还是旧 URL。
    const ext = file.name.split('.').pop() ?? 'jpg'
    const path = `${userId}.${crypto.randomUUID()}.${ext}`
    const { error: uploadError } = await dataClient.storage.from('avatars').upload(path, file)
    if (uploadError) return { success: false, error: uploadError.message }
    const { data: { publicUrl } } = dataClient.storage.from('avatars').getPublicUrl(path)
    const { error: updateError } = await supabase.auth.updateUser({ data: { avatar_url: publicUrl } })
    if (updateError) return { success: false, error: updateError.message }
    const profileError = await updateIdentityUserProfile(userId, { avatar: publicUrl })
    if (profileError) return { success: false, error: profileError }
    return { success: true, avatarUrl: publicUrl }
  }
}
