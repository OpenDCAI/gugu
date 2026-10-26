import { useEffect, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { GroupChatSettings, GroupJoinMode, UpdateGroupChatSettingsInput } from '@gugu/core/shared/types/chat'
import { GroupAgentFloodSettings } from './GroupAgentFloodSettings'
import { ProjectFileSettings } from './ProjectFileSettings'
import { joinModeDescription } from './chatPresentation'
import { isProjectGroupChat } from '../../lib/groupMemberPermissions'
import { GroupInviteLinkBlock, SettingsToggleRow } from './groupSettingsUi'
import {
  settingsCenteredRowStyle,
  settingsInputStyle,
  settingsMutedTextStyle,
  settingsRowStyle,
  settingsRowSubtitleStyle,
  settingsRowTitleStyle,
  settingsSectionLabelStyle,
  settingsSelectStyle,
} from './groupSettingsStyles'

const firstSectionLabelStyle: CSSProperties = { ...settingsSectionLabelStyle, borderTop: 'none', paddingTop: 0, marginTop: 0 }
const limitErrorStyle: CSSProperties = { fontSize: 'var(--font-caption)', color: 'var(--danger)', marginTop: -8, paddingBottom: 8 }
const limitStyle: CSSProperties = { ...settingsMutedTextStyle, display: 'flex', alignItems: 'center', gap: 4 }

/**
 * @@@6418 「群管理」二级页 —— 只有群主/管理员进得来(入口在一级页按角色渲染)。
 * 原来这些开关对普通成员以禁用态铺在一级页上;现在整页只对管理者存在。
 * 所有项即时落库(useGroupChatSettings.update);成员上限是数字,回车或失焦才写。
 */
export function GroupSettingsManagePage({ chatId, settings, totalMembers, inviteLink, onUpdate, onOpenPoster }: {
  chatId: string
  settings: GroupChatSettings
  totalMembers: number
  inviteLink: string | null
  onUpdate: (input: UpdateGroupChatSettingsInput) => Promise<boolean>
  onOpenPoster: () => void
}) {
  const { t } = useTranslation('messaging')
  const [maxMembersDraft, setMaxMembersDraft] = useState(String(settings.max_members))
  const [limitInvalid, setLimitInvalid] = useState(false)
  useEffect(() => { setMaxMembersDraft(String(settings.max_members)) }, [settings.max_members])

  const commitMaxMembers = () => {
    const next = Number(maxMembersDraft.trim())
    if (next === settings.max_members) { setLimitInvalid(false); return }
    // 空 / 小数 / <1:不发请求、不把非法值乐观写进本地(否则输入框会闪出 NaN),留着草稿并说明原因。
    if (!maxMembersDraft.trim() || !Number.isInteger(next) || next < 1) { setLimitInvalid(true); return }
    setLimitInvalid(false)
    void onUpdate({ max_members: next }).then((ok) => { if (!ok) setMaxMembersDraft(String(settings.max_members)) })
  }

  const projectGroup = isProjectGroupChat(chatId)
  return (
    <>
      {projectGroup && <ProjectFileSettings key={chatId} chatId={chatId} />}
      <div style={firstSectionLabelStyle}>{t('group.settings.sectionJoin')}</div>
      {/* 项目群不拉人(gugu-dev#181):入群方式、成员邀请、邀请链接都不提供,说一句原因;agent 那几样照旧。 */}
      {projectGroup ? (
        <div data-testid="project-group-no-invite" style={settingsRowStyle}><div style={settingsRowSubtitleStyle}>{t('group.projectGroupNoInvite')}</div></div>
      ) : (
        <>
      <div style={settingsRowStyle}>
        <div>
          <div style={settingsRowTitleStyle}>{t('group.settings.joinMode')}</div>
          <div style={settingsRowSubtitleStyle}>{joinModeDescription(settings.join_mode, t)}</div>
        </div>
        <select
          value={settings.join_mode}
          onChange={(event) => { void onUpdate({ join_mode: event.target.value as GroupJoinMode }) }}
          aria-label={t('group.settings.joinMode')}
          style={settingsSelectStyle}
        >
          <option value="open">{t('group.settings.joinModeOptions.open')}</option>
          <option value="approval">{t('group.settings.joinModeOptions.approval')}</option>
          <option value="invite_only">{t('group.settings.joinModeOptions.inviteOnly')}</option>
        </select>
      </div>
      <SettingsToggleRow
        title={t('group.settings.allowMemberInvite')}
        description={t('group.settings.allowMemberInviteDescription')}
        ariaLabel={t('group.settings.allowMemberInviteAria')}
        checked={settings.allow_member_invite}
        onChange={(next) => { void onUpdate({ allow_member_invite: next }) }}
      />
        </>
      )}
      <SettingsToggleRow
        title={t('group.settings.agentApproval')}
        description={t('group.settings.agentApprovalDescription')}
        ariaLabel={t('group.settings.agentApprovalAria')}
        checked={settings.agent_join_approval}
        onChange={(next) => { void onUpdate({ agent_join_approval: next }) }}
      />

      {projectGroup ? null : (
        <>
      <div style={settingsSectionLabelStyle}>{t('group.settings.sectionInvite')}</div>
      <SettingsToggleRow
        title={t('group.settings.inviteLink')}
        description={t('group.settings.inviteLinkDescription')}
        ariaLabel={t('group.settings.inviteLinkAria')}
        checked={settings.invite_link_enabled}
        onChange={(next) => { void onUpdate({ invite_link_enabled: next }) }}
      />
      {/* 开关关掉时链接对加入无效(DB RPC 拒 token join),所以连链接带海报一起收起(#1164-G2 / #445)。 */}
      {settings.invite_link_enabled && inviteLink ? <GroupInviteLinkBlock inviteLink={inviteLink} onOpenPoster={onOpenPoster} /> : null}

        </>
      )}

      <div style={settingsSectionLabelStyle}>{t('group.settings.sectionAgents')}</div>
      {/* @@@5856 / #5999 agent 数量线(含话题阈值)统一在群设置里管,❌ 回到成员面板。 */}
      <GroupAgentFloodSettings key={chatId} chatId={chatId} editable />

      <div style={settingsSectionLabelStyle}>{t('group.settings.sectionMembers')}</div>
      <div style={settingsCenteredRowStyle}>
        <div style={settingsRowTitleStyle}>{t('group.settings.memberLimit')}</div>
        <div style={limitStyle}>
          <span>{totalMembers} /</span>
          <input
            type="number"
            min={1}
            aria-label={t('group.settings.memberLimit')}
            value={maxMembersDraft}
            onChange={(event) => setMaxMembersDraft(event.target.value)}
            aria-invalid={limitInvalid || undefined}
            onBlur={commitMaxMembers}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
            style={settingsInputStyle}
          />
        </div>
      </div>
      {limitInvalid ? <div role="alert" style={limitErrorStyle}>{t('group.settings.memberLimitError')}</div> : null}
      <SettingsToggleRow
        title={t('group.settings.hideHistory')}
        description={t('group.settings.hideHistoryDescription')}
        ariaLabel={t('group.settings.hideHistoryAria')}
        checked={settings.hide_history}
        onChange={(next) => { void onUpdate({ hide_history: next }) }}
      />
    </>
  )
}
