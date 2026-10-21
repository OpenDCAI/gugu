import { describe, expect, it } from 'vitest'
import {
  AGENT_AVATAR_MAX_BYTES,
  agentAvatarStoragePath,
  managedAgentAvatarPath,
  validateAgentAvatarFile,
  validateAgentAvatarFileCode,
} from '../../../../apps/desktop/src/lib/agentAvatar'

describe('agent avatar update primitive', () => {
  it('accepts supported image types within the storage limit', () => {
    expect(validateAgentAvatarFile({ type: 'image/png', size: AGENT_AVATAR_MAX_BYTES })).toBeNull()
  })

  it('rejects non-images and oversized files before upload', () => {
    expect(validateAgentAvatarFile({ type: 'text/plain', size: 1 })).toContain('PNG')
    expect(validateAgentAvatarFile({ type: 'image/png', size: AGENT_AVATAR_MAX_BYTES + 1 })).toContain('5 MB')
  })

  it('returns stable validation codes while the legacy API retains its Chinese messages', () => {
    expect(validateAgentAvatarFileCode({ type: 'text/plain', size: 1 })).toBe('invalid-type')
    expect(validateAgentAvatarFileCode({ type: 'image/png', size: AGENT_AVATAR_MAX_BYTES + 1 })).toBe('too-large')
    expect(validateAgentAvatarFileCode({ type: 'image/png', size: 0 })).toBe('empty-file')
    expect(validateAgentAvatarFile({ type: 'image/png', size: 0 })).toBe('头像文件不能为空')
  })

  it('centralizes owner-scoped storage keys and extracts only managed objects for cleanup', () => {
    const path = agentAvatarStoragePath('owner-1', 'agent-2', 'image/jpeg', 'nonce')
    expect(path).toBe('owner-1.agent-2-nonce.jpg')
    expect(managedAgentAvatarPath(`https://db.example/storage/v1/object/public/avatars/${path}?v=1`)).toBe(path)
    expect(managedAgentAvatarPath('./assets/agent-avatars/avatar-01.png')).toBeNull()
  })
})
