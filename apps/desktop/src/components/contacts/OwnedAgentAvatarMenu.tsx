import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { RefreshCw, RotateCcw } from '@/lib/icons'
import { messageForUser } from '@/lib/userFacingError'
import { AGENT_AVATAR_PALETTES, agentAvatarPaletteIndex, parseBoringLook, type BoringLook } from '../../lib/agentAvatarPalette'
import { contactsService } from '../../lib/contacts'
import { useIsAssistantAvatar } from '../../lib/avatarIdentity'
import { useAuth } from '../../store/auth'
import { useContactsStore } from '../../store/contactsContext'
import { isBuiltinAgentAvatarUrl } from '../agentAvatar/look'
import { BoringAgentAvatar } from '../BoringAgentAvatar'
import { useToast } from '../toastContext'
import { Button } from '../ui/Button'
import { Menu, MenuItem } from '../ui/Menu'

/**
 * The owner's default-face menu on an agent's avatar: pick one of the curated palettes, roll a new shape, or go back to
 * the face the id gives. Uploaded photos and the assistant's figure keep their own editors; others see the plain avatar.
 */
export function OwnedAgentAvatarMenu({ agentId, avatar, ownerUserId, status, membership, children }: {
  agentId: string
  avatar?: string | null
  ownerUserId?: string | null
  status?: AgentDisplayStatus
  membership?: string
  /** The avatar as the host draws it. */
  children: ReactNode
}) {
  const { t } = useTranslation('contacts')
  const { user } = useAuth()
  const { updateAgentProfile } = useContactsStore()
  const { toast } = useToast()
  const assistant = useIsAssistantAvatar(agentId)
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const canPick = !!user?.id && ownerUserId === user.id && status !== 'removed' && membership !== 'removed' && !assistant
    && (avatar == null || isBuiltinAgentAvatarUrl(avatar))
  if (!canPick) return <>{children}</>

  const current: BoringLook = parseBoringLook(avatar) ?? { palette: agentAvatarPaletteIndex(agentId), seed: null }
  const save = async (next: string | null) => {
    setSaving(true)
    try {
      await updateAgentProfile(agentId, { avatar: next })
      setOpen(false)
    } catch (err) {
      toast(t('agentAvatar.failed'), 'error', messageForUser(err))
    } finally {
      setSaving(false)
    }
  }
  const pick = (look: BoringLook) => void save(contactsService.boringLookAvatarUrl(look))

  return (
    <>
      <Button ref={anchor} variant="ghost" aria-label={t('agentAvatar.change')} aria-haspopup="menu" aria-expanded={open}
        className="block h-auto min-h-0 rounded-full p-0 max-[719px]:min-h-0" onClick={() => setOpen(true)}>
        {children}
      </Button>
      {open && (
        <Menu anchor={anchor} minWidth={0} ariaLabel={t('agentAvatar.change')} onClose={() => setOpen(false)}>
          <div role="radiogroup" aria-label={t('agentAvatar.palettes')} data-testid="agent-avatar-palettes" className="grid grid-cols-5 gap-1 p-2">
            {AGENT_AVATAR_PALETTES.map((_, palette) => (
              <Button key={palette} variant="option" size="icon" role="radio" disabled={saving} aria-checked={palette === current.palette}
                aria-label={t('agentAvatar.palette', { n: palette + 1 })} className="rounded-full" onClick={() => pick({ palette, seed: current.seed })}>
                <BoringAgentAvatar id={agentId} name="" size={24} avatar={contactsService.boringLookAvatarUrl({ palette, seed: current.seed })} />
              </Button>
            ))}
          </div>
          <MenuItem icon={<RefreshCw size={15} />} disabled={saving} closeOnClick={false} data-testid="agent-avatar-roll"
            onClick={() => pick({ palette: current.palette, seed: crypto.randomUUID().slice(0, 8) })}>
            {t('agentAvatar.roll')}
          </MenuItem>
          <MenuItem icon={<RotateCcw size={15} />} disabled={saving || avatar == null} closeOnClick={false} data-testid="agent-avatar-reset"
            onClick={() => void save(null)}>
            {t('agentAvatar.reset')}
          </MenuItem>
        </Menu>
      )}
    </>
  )
}
