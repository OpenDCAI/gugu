import { i18n } from '@/i18n'
import { LOOK_ROOT } from '@/components/agentAvatar/look'

export const AGENT_AVATAR_MAX_BYTES = 5 * 1024 * 1024

export const AGENT_AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export type AgentAvatarFileLike = {
  type: string
  size: number
  name?: string
}

export type AgentAvatarValidationCode = 'invalid-type' | 'too-large' | 'empty-file'

export function validateAgentAvatarFileCode(file: AgentAvatarFileLike): AgentAvatarValidationCode | null {
  if (!AGENT_AVATAR_MIME_TYPES.includes(file.type as (typeof AGENT_AVATAR_MIME_TYPES)[number])) {
    return 'invalid-type'
  }
  if (file.size > AGENT_AVATAR_MAX_BYTES) return 'too-large'
  if (file.size <= 0) return 'empty-file'
  return null
}

export function validateAgentAvatarFile(file: AgentAvatarFileLike): string | null {
  const code = validateAgentAvatarFileCode(file)
  const keys: Record<AgentAvatarValidationCode, string> = {
    'invalid-type': 'settings.profile.invalidType',
    'too-large': 'settings.profile.tooLarge',
    'empty-file': 'settings.profile.emptyFile',
  }
  return code ? i18n.t(keys[code], { ns: 'agents' }) : null
}

export function agentAvatarExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg': return 'jpg'
    case 'image/gif': return 'gif'
    case 'image/webp': return 'webp'
    default: return 'png'
  }
}

/** Storage owns the object key shape; callers should not concatenate avatar paths. */
export function agentAvatarStoragePath(ownerId: string, agentId: string, mimeType: string, nonce: string): string {
  return `${ownerId}.${agentId}-${nonce}.${agentAvatarExtension(mimeType)}`
}

export function managedAgentAvatarPath(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null
  const marker = '/object/public/avatars/'
  const index = publicUrl.indexOf(marker)
  if (index < 0) return null
  const path = publicUrl.slice(index + marker.length).split(/[?#]/)[0]
  // agent-look/ 下是所有 agent 共用的形象定格图,不归任何一只 agent 管:换形象 / 换照片时 ❌ 去删它。
  // 按路径判,不按「认不认得出这个形象」判 —— 新版本加的表情、缺了 ?rest= 的地址,这个客户端认不出,但照样是共用的。
  if (path.startsWith(`${LOOK_ROOT}/`)) return null
  return path || null
}
