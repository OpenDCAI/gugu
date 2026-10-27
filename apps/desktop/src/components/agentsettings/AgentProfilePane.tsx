import { messageForUser } from '@/lib/userFacingError';
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rendererLogger } from '../../lib/log'
import { Image, Palette } from '@/lib/icons'
import type { AgentSettingsPaneProps } from './types'
import { useContactsStore } from '../../store/contactsContext'
import { useAuth } from '../../store/auth'
import { closeIfMyAssistant } from '../../lib/assistantClose'
import { useToast } from '../toastContext'
import { asClass, profileInputClass } from './agentSettingsStyles'
import { useIsAssistantAvatar } from '../../lib/avatarIdentity'
import { Avatar } from '../Avatar'
import { validateAgentAvatarFileCode, type AgentAvatarValidationCode } from '../../lib/agentAvatar'
import { Button } from '../ui/Button'
import { AgentPauseRow } from './AgentPauseRow'
import './AgentProfilePane.css'

const AVATAR_VALIDATION_KEYS = {
  'invalid-type': 'settings.profile.invalidType',
  'too-large': 'settings.profile.tooLarge',
  'empty-file': 'settings.profile.emptyFile',
} as const satisfies Record<AgentAvatarValidationCode, string>

const profileLog = rendererLogger('agents/profile')

export function AgentProfilePane({ agent, onClose, onOpenTab }: AgentSettingsPaneProps) {
  const { t } = useTranslation('agents')
  const assistant = useIsAssistantAvatar(agent.id)
  const { updateAgentProfile, uploadAgentAvatar, removeOwnedAgent } = useContactsStore()
  const { user } = useAuth()
  const { toast } = useToast()

  const isOwnedAgent = agent.type === 'agent' && !!agent.owner_user_id && agent.owner_user_id === user?.id

  const [name, setName] = useState(agent.display_name)
  // #1228: bio 受控 — 原先 textarea 是 defaultValue 非受控、保存只存 name、bio 静默丢。
  const [bio, setBio] = useState(agent.bio ?? '')
  // 头像不在这里另存一份:形象页、别的设备随时会改它,这一页只显示库里那份(选了新照片时显示预览)。
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  function selectFile(file: File | undefined) {
    if (!file || !isOwnedAgent || saving) return
    const validationCode = validateAgentAvatarFileCode(file)
    if (validationCode) {
      toast(t(AVATAR_VALIDATION_KEYS[validationCode]), 'error')
      return
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    const nextPreview = URL.createObjectURL(file)
    setPreviewUrl(nextPreview)
    setPendingFile(file)
  }

  async function handleSave() {
    if (!isOwnedAgent) return
    const normalizedName = name.trim()
    if (!normalizedName) {
      setNameError(t('settings.profile.nameRequired'))
      return
    }
    setNameError(null)
    setSaving(true)
    try {
      const profile = { name: normalizedName, bio }
      // 头像只走上传这一条路;❌ 把打开时看到的那份头像带回去 —— 那会盖掉形象页刚存的形象。
      if (pendingFile) await uploadAgentAvatar(agent.id, pendingFile, profile)
      else await updateAgentProfile(agent.id, profile)
      setName(normalizedName)
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setPreviewUrl(null)
      setPendingFile(null)
      toast(t('settings.profile.saved'), 'success')
    } catch (err) {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setPreviewUrl(null)
      setPendingFile(null)
      console.error('[AgentProfilePane] failed to save agent profile', err)
      toast(t('settings.profile.saveFailed'), 'error', messageForUser(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!isOwnedAgent) return
    // #7350 删的是咕咕:换成关闭咕咕那一份确认(写清记忆、性格、它开过的会话),这个设置窗让给它。
    if (closeIfMyAssistant(user?.id, agent.id)) return onClose?.()
    if (!window.confirm(t('settings.profile.confirmDelete', { name: agent.display_name }))) return
    setRemoving(true)
    try {
      await removeOwnedAgent(agent.id)
      toast(t('settings.profile.deleted'), 'success')
      onClose?.()
    } catch (err) {
      profileLog.error({ err: String((err as Error)?.message ?? err) }, 'delete agent failed')
      toast(t('settings.profile.deleteFailed'), 'error', messageForUser(err))
      setRemoving(false)
    }
  }

  return (
    <div className="gg-agent-profile">
      <div className="gg-agent-profile-content" data-testid="agent-profile-content">
      {/* 头像 + 名称 — verbatim layout from design line 973 */}
      <div className={asClass.profileRow}>
        {/* #1461: 走统一 <Avatar>（seed=agent.id）而非裸 <img>；canonical preset/upload URL
            与聊天列表 / 新建群聊 / 通讯录 等所有 surface 共享同一 projection。 */}
        <div className={asClass.profileAvatar}>
          <Avatar
            name={agent.display_name}
            avatarUrl={previewUrl ?? agent.avatar}
            seed={agent.id}
            size={52}
            isAgent={agent.type === 'agent'}
          />
        </div>
        <div className={asClass.profileAprField}>
          <div className={asClass.profileLabel}>{t('settings.profile.name')}</div>
          <div className={asClass.profileNameWrap}>
            <input
              className={profileInputClass()}
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (nameError) setNameError(null)
              }}
              disabled={!isOwnedAgent || saving}
              aria-invalid={nameError ? 'true' : undefined}
              aria-describedby={nameError ? 'agent-profile-name-error' : undefined}
              // TODO(agent-bio-update): read-only for non-owned agents; rename only for owned
            />
            {/* chevron */}
            <svg
              className={asClass.profileNameChevron}
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6"/>
            </svg>
          </div>
          {nameError && (
            <div id="agent-profile-name-error" className={asClass.profileError} role="alert">
              {nameError}
            </div>
          )}
        </div>
      </div>

      <div className={asClass.profileField}>
        {/* @@@2470 预设选择格子已删除：那 32 张 gugu Classic 卡通图整套下架。头像要么是 owner 真正
            上传的图（=身份），要么没有——没有就按稳定 id 生成默认脸。中间不再有「像策展作品、
            但其实是从小图库里发的」这一档。 */}
        <div className={asClass.profileLabel}>{t('settings.profile.avatar')}</div>
        <div className="flex flex-wrap items-center gap-2">
          {assistant && onOpenTab ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="gg-as-profile-look"
              onClick={() => onOpenTab('look')}
            >
              <Palette aria-hidden="true" className="h-4 w-4" />
              {t('settings.profile.openStudio')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="gg-as-profile-upload"
            disabled={!isOwnedAgent || saving}
            onClick={() => avatarInputRef.current?.click()}
          >
            <Image aria-hidden="true" className="h-4 w-4" />
            {t('settings.profile.upload')}
          </Button>
        </div>
        <input
          ref={avatarInputRef}
          id="agent-avatar-upload-input"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          data-testid="agent-avatar-upload-input"
          className="sr-only"
          disabled={!isOwnedAgent || saving}
          onChange={(event) => {
            selectFile(event.target.files?.[0])
            event.currentTarget.value = ''
          }}
        />
        {/* exact 718 shipped this as 0px: tokens.css's unlayered reset wins over mt-1. I18n must preserve that measured shape. */}
        <div
          className="mt-1 text-[length:var(--font-caption)] text-[var(--faint-fg)]"
        >
          {t('settings.profile.uploadHint')}
        </div>
      </div>

      {/* Agent ID */}
      <div className={asClass.profileField}>
        <div className={asClass.profileLabel}>{t('settings.profile.idLabel')}</div>
        <input
          className={profileInputClass('readonly')}
          readOnly
          value={agent.id}
        />
      </div>

      {/* 简介 */}
      <div className={asClass.profileField}>
        <div className={asClass.profileLabel}>{t('settings.profile.bio')}</div>
        <textarea
          className={profileInputClass('textarea')}
          placeholder={t('settings.profile.bioPlaceholder')}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          disabled={!isOwnedAgent || saving}
        />
      </div>

      </div>
      <div className="gg-agent-profile-actions" data-testid="agent-profile-actions">
        <div className="gg-agent-profile-save-row">
          <Button className="gg-as-profile-save" variant="primary" onClick={handleSave} disabled={!isOwnedAgent || saving || removing}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </div>
        <div className="gg-agent-profile-manage">
          <AgentPauseRow agent={agent} />
          <Button className="gg-as-profile-danger" variant="danger" onClick={handleDelete} disabled={!isOwnedAgent || saving || removing}>
            {removing ? t('settings.profile.deleting') : t('settings.profile.deleteAgent')}
          </Button>
        </div>
      </div>
    </div>
  )
}
