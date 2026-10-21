/**
 * BuildAgentWizard — 多步 Agent 团队生成向导
 *
 * 现状：@@@1438 的「预置 Agent 团队」方向已开工——ExplorePage 广场预设团队入口以
 * `initialTeam` 直入「预览 → 创建」，onCreate 接 durable team-provision saga
 * （DB 权威有界并发、真终态、全员完成后原子建群）。
 *
 * 范围：不做付费/unlock/agentcopy；核心流程：描述需求 → 预览生成的多 agent
 *         多 agent 团队 → 确认创建；成员顺序只用于展示，不产生队长、督导或权限语义。
 *
 * 纯展示组件，props 驱动：
 *   onGenerate(desc) → Promise<AgentTeam>
 *   onCreate(team)   → void | Promise<void>（reject = 创建失败 → 回预览步 + wizard-error）
 *   onClose()        → void
 *
 * 样式沿用 gugu UI token：var(--accent)/var(--text-*)/var(--border-color)/var(--bg-*)
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { cleanupStepsText } from '@/lib/cleanupStageCopy'
import { useTranslation } from 'react-i18next'
import { rendererLogger } from '../lib/log'
import { ComposerAgentSelector, type ComposerAgentOption } from '@gugu/session-ui/react/components'
import { ThemeProvider as SessionUiThemeProvider } from '@gugu/session-ui/react/primitives'
import { Avatar } from './Avatar'
import { TemplateRoleMarker } from './TemplateRoleMarker'
import { customAvatarUrl } from '../lib/dicebearAvatar'
import { generateAgentTeam } from '../lib/teamGenerate'
import type { CreateTeamCancelResult, CreateTeamProgress, CreateTeamResult } from '../lib/createAgentTeam'
import type { SelectableAgentType } from '@gugu/core/shared/enums/agentTypeModels'
import {
  LOCAL_AGENT_CREATION_TOOLS,
  loadLocalAgentCreationTools,
  type LocalAgentCreationTool,
} from '../lib/agentCreationTools'
import { Sheet } from './ui/Sheet'
import { useTheme } from '../store/theme'
import { platform } from '../platform'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentTeamMember {
  /** 临时 ID，用于 key */
  tempId: string
  /** 角色名称，例如 "PM" / "Engineer" / "Designer" */
  role: string
  /** 展示名称，例如 "Alice the PM" */
  displayName: string
  /** 简短能力描述 */
  description: string
  /** 头像 URL，可能为 null（由 LLM 生成后填入） */
  avatarUrl: string | null
  /** agent engine 类型，对应 `engine-injection-contract.ts` CONTRACTS 里的 engineId。 */
  engineId: string
  /**
   * 该成员的 persona / 具体目标 —— 创建时注入 create_owned_agent 的 special_focus，
   * 让 agent 一上来就知道自己是谁、只做什么。预设团队带完整 persona；LLM 生成的团队
   * 无此字段时创建方回落 description。
   */
  specialFocus?: string
  /** @@@2470 模板美术的 key（非身份 key）：预览位按它取脸，确定性且与姓名解耦。 */
  /** @@@2470 模板美术的 key（非身份 key）。**必填**：可选会诱出 `?? role` 这类姓名回落，
   *  而 role 来自 display_name —— 与「模板 key 与显示名解耦」直接矛盾（review3 F2/F7）。 */
  avatarSeed: string
}

export interface AgentTeam {
  /** 用户的原始描述 */
  userDescription: string
  /** 团队名，LLM 生成 */
  teamName: string
  /** 团队成员列表，顺序只用于预览，不赋予成员特殊权限。 */
  members: AgentTeamMember[]
  /** 团队章程（建群时写入 group_prompt）。预设团队带；LLM 团队可空。 */
  groupPrompt?: string
  /** 预设团队的可编辑开场任务；建群后只写入该群草稿，不自动发送。 */
  starterPrompt?: string
}

export interface BuildAgentWizardProps {
  /**
   * 根据用户描述调用 LLM 生成 team 配置。
   * 默认使用 lib/teamGenerate.generateAgentTeam（服务端读 GUGU_SERVER_LLM_* 配置）。
   * trunk 可注入 edge fn "team-generate" 实现以切换后端。
   */
  onGenerate?: (description: string) => Promise<AgentTeam>
  /**
   * 用户确认后批量创建 agent。返回 Promise 时向导会等它完成再进 done 步（失败回 preview）。
   * 接线实现见 lib/createAgentTeam.ts：把预览意图交给 durable team-provision saga。
   * onProgress：#1981 分阶段进度回调——向导把它透传给 createAgentTeam，等待态据此渲染真实
   * 进度（阶段文案 + 进度条），取代 ~32s 的裸 spinner。父组件不接则无进度、退化为不确定态。
   */
  onCreate: (team: AgentTeam, onProgress?: (p: CreateTeamProgress) => void) => CreateTeamResult | void | Promise<CreateTeamResult | void>
  /** Runs success-side UI effects only while this create attempt is still current. */
  onCreated?: (team: AgentTeam, result: CreateTeamResult) => void | Promise<void>
  onClose: () => void
  /** Explicit destructive cancel; ordinary close applies only outside the creating step. */
  onCancel?: (operationId: string) => Promise<CreateTeamCancelResult>
  /** Exact durable operation whose earlier explicit cancellation is still converging. */
  initialCancellationOperationId?: string
  /**
   * 可选：从 AgentPresetsPanel 带入的初始描述，预填 DescribeStep 的文本框。
   * 父组件在 AgentPresetsPanel.onSelect 回调中传入 preset.description。
   */
  initialDescription?: string
  /**
   * 可选：直接带入一个已经定好的团队（预设团队）→ 跳过「描述→生成」，直接进「预览→创建」。
   * 传入即视作固定预设,不走 LLM 生成。
   */
  initialTeam?: AgentTeam
}

// ─────────────────────────────────────────────────────────────────────────────
// Step type
// ─────────────────────────────────────────────────────────────────────────────

type Step = 'describe' | 'generating' | 'preview' | 'creating' | 'cancellation-recovery' | 'done'

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function StepDots({ current }: { current: 'describe' | 'preview' | 'done' }) {
  const steps: Array<'describe' | 'preview' | 'done'> = ['describe', 'preview', 'done']
  return (
    <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginBottom: 20 }}>
      {steps.map((s) => (
        <span
          key={s}
          style={{
            width: 8,
            height: 8,
            borderRadius: 'var(--radius-circle)',
            background: s === current ? 'var(--accent)' : 'var(--border-color)',
            transition: 'background var(--dur-slow) var(--ease)',
          }}
        />
      ))}
    </div>
  )
}

function SpinnerIcon() {
  return (
    <div
      style={{
        width: 32,
        height: 32,
        borderRadius: 'var(--radius-circle)',
        border: '3px solid var(--border-color)',
        borderTopColor: 'var(--accent)',
        animation: 'wizardSpin 0.8s linear infinite',
      }}
    />
  )
}

function MemberCard({
  member,
  onEngineChange,
  tools,
}: {
  member: AgentTeamMember
  onEngineChange: (memberId: string, engineId: SelectableAgentType) => void
  tools: readonly LocalAgentCreationTool[]
}) {
  const { t } = useTranslation('agents')
  const engineOptions: ComposerAgentOption[] = tools.map((tool) => ({
    id: tool.engine,
    name: tool.label,
    icon: <img src={tool.icon} alt="" width={14} height={14} />,
  }))
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '12px 14px',
        borderRadius: 'var(--radius-xl)',
        border: '1px solid var(--border-color)',
        background: 'var(--bg-elevated)',
        position: 'relative',
      }}
    >
      {/* @@@2470 向导里的成员尚未 provision，没有身份 id：用模板标记，绝不冒充最终 agent 的脸。
          真实上传的头像（member.avatarUrl）仍原样投影——那是用户显式给的图。 */}
      {customAvatarUrl(member.avatarUrl, `wizard member "${member.displayName}"`) ? (
        <Avatar avatarUrl={member.avatarUrl} name={member.displayName} seed={member.avatarSeed} size="md" />
      ) : (
        <TemplateRoleMarker
          roleKey={member.avatarSeed}
          templateLabel={t('wizard.roleTemplate', { title: member.displayName })}
          size={40}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 'var(--font-body)', color: 'var(--text-primary)' }}>
            {member.displayName}
          </span>
          <span
            style={{
              fontSize: 'var(--font-caption)',
              fontWeight: 500,
              padding: '1px 7px',
              borderRadius: 'var(--radius-document)',
              background: 'var(--bg-elevated)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-color)',
            }}
          >
            {member.role}
          </span>
          <span
            data-member-engine={member.tempId}
            data-member-engine-value={member.engineId}
            style={{ marginLeft: 'auto', flexShrink: 0 }}
          >
            <ComposerAgentSelector
              options={engineOptions}
              selectedId={member.engineId}
              onSelect={(engineId) => onEngineChange(member.tempId, engineId as SelectableAgentType)}
              label={t('wizard.memberEngine', { name: member.displayName })}
              searchPlaceholder={t('create.composer.searchProviders')}
              optionTestIdPrefix={`member-engine-option-${member.tempId}`}
              popupZIndex="var(--z-menu)"
            />
          </span>
        </div>
        <p
          style={{
            margin: '4px 0 0',
            fontSize: 'var(--font-body)',
            color: 'var(--text-secondary)',
            lineHeight: 1.5,
          }}
        >
          {member.description}
        </p>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step: describe
// ─────────────────────────────────────────────────────────────────────────────

function DescribeStep({
  onSubmit,
  initialDescription = '',
}: {
  onSubmit: (desc: string) => void
  initialDescription?: string
}) {
  const { t } = useTranslation('agents')
  const [desc, setDesc] = useState(initialDescription)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
          {t('wizard.describeTitle')}
        </h2>
        <p style={{ margin: 0, fontSize: 'var(--font-body)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {t('wizard.describeBody')}
        </p>
      </div>

      <textarea
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder={t('wizard.descriptionPlaceholder')}
        rows={4}
        style={{
          width: '100%',
          resize: 'none',
          borderRadius: 'var(--radius-xl)',
          border: '1px solid var(--border-color)',
          background: 'var(--bg-elevated)',
          color: 'var(--text-primary)',
          fontSize: 'var(--font-body)',
          padding: '10px 12px',
          lineHeight: 1.6,
          boxSizing: 'border-box',
        }}
        autoFocus
      />

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          disabled={!desc.trim()}
          onClick={() => onSubmit(desc.trim())}
          style={{
            padding: '8px 20px',
            borderRadius: 'var(--radius-control)',
            border: 'none',
            background: desc.trim() ? 'var(--accent)' : 'var(--bg-elevated)',
            color: desc.trim() ? 'var(--text-on-accent)' : 'var(--text-tertiary)',
            fontSize: 'var(--font-body)',
            fontWeight: 600,
            cursor: desc.trim() ? 'pointer' : 'default',
            transition: 'background var(--dur-fast) var(--ease)',
          }}
        >
          {t('wizard.generate')}
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step: generating（loading 动画）
// ─────────────────────────────────────────────────────────────────────────────

function GeneratingStep() {
  const { t } = useTranslation('agents')
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 16,
        padding: '32px 0',
      }}
    >
      <SpinnerIcon />
      <p style={{ margin: 0, fontSize: 'var(--font-body)', color: 'var(--text-secondary)', textAlign: 'center' }}>
        {t('wizard.generating')}
      </p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step: preview
// ─────────────────────────────────────────────────────────────────────────────

function PreviewStep({
  team,
  onBack,
  onConfirm,
  onEngineChange,
  tools,
  onStarterPromptChange,
  summaryLabel,
  backLabel,
}: {
  team: AgentTeam
  onBack: () => void
  onConfirm: () => void
  onEngineChange: (memberId: string, engineId: SelectableAgentType) => void
  tools: readonly LocalAgentCreationTool[]
  onStarterPromptChange: (prompt: string) => void
  summaryLabel?: string
  backLabel?: string
}) {
  const { t } = useTranslation('agents')
  const resolvedSummary = summaryLabel ?? t('wizard.generatedSummary')
  const resolvedBackLabel = backLabel ?? t('wizard.regenerate')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
          {team.teamName}
        </h2>
        <p style={{ margin: 0, fontSize: 'var(--font-body)', color: 'var(--text-secondary)' }}>
          {t('wizard.memberSummary', { count: team.members.length, summary: resolvedSummary })}
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {team.members.map((m) => (
          <MemberCard key={m.tempId} member={m} onEngineChange={onEngineChange} tools={tools} />
        ))}
      </div>

      {team.starterPrompt !== undefined && (
        <div style={{ display: 'grid', gap: 7 }}>
          <label
            htmlFor="wizard-starter-prompt"
            style={{ fontSize: 'var(--font-body)', fontWeight: 600, color: 'var(--text-primary)' }}
          >
            {t('wizard.starterPrompt')}
          </label>
          <textarea
            id="wizard-starter-prompt"
            data-testid="wizard-starter-prompt"
            value={team.starterPrompt}
            onChange={(event) => { onStarterPromptChange(event.target.value) }}
            rows={5}
            style={{
              width: '100%', minHeight: 108, maxHeight: 180, resize: 'vertical', boxSizing: 'border-box',
              border: '1px solid var(--border-color)', borderRadius: 'var(--radius-control)', padding: '10px 12px',
              background: 'var(--bg-elevated)', color: 'var(--text-primary)',
              font: 'inherit', fontSize: 'var(--font-body)', lineHeight: 1.55, letterSpacing: 0,
            }}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onBack}
          style={{
            padding: '8px 16px',
            borderRadius: 'var(--radius-control)',
            border: '1px solid var(--border-color)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: 'var(--font-body)',
            cursor: 'pointer',
          }}
        >
          {resolvedBackLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          data-testid="wizard-create"
          style={{
            padding: '8px 20px',
            borderRadius: 'var(--radius-control)',
            border: 'none',
            background: 'var(--accent)',
            color: 'var(--text-on-accent)',
            fontSize: 'var(--font-body)',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {t('wizard.create')}
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step: creating（创建中）
// ─────────────────────────────────────────────────────────────────────────────

// #1981 创建等待态：不再是裸 spinner。createAgentTeam 经 onProgress 回填 durable saga 的真实阶段
// （检查设备→有界并发 provision→原子 finalize→就位），这里把阶段文案 + 进度条渲染出来，
// 让用户看到「在干什么、到哪了」。stage=null（尚无进度事件）→ 进度条 0 + 不确定文案。
function CreatingStep({
  teamName,
  stage,
  operationId,
  cancelling,
  cancelConfirming,
  onCancelRequest,
  onCancelConfirm,
  onCancelAbort,
}: {
  teamName: string
  stage: CreateTeamProgress | null
  operationId: string | null
  cancelling: boolean
  cancelConfirming: boolean
  onCancelRequest: () => void
  onCancelConfirm: () => void
  onCancelAbort: () => void
}) {
  const { t } = useTranslation('agents')
  const percent = stage ? Math.round(stage.ratio * 100) : 0
  let label = t('wizard.creating', { teamName })
  if (stage?.code === 'resuming') label = t('wizard.progress.resuming')
  else if (stage?.code === 'ready') label = t('wizard.progress.ready')
  else if (stage?.code === 'checking-device') label = t('wizard.progress.checkingDevice')
  else if (stage?.code === 'provisioning' && stage.provisioningCount !== undefined) {
    label = t('wizard.progress.provisioning', { count: stage.provisioningCount })
  } else if (stage?.label) label = stage.label
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 16,
        padding: '32px 0',
      }}
    >
      <SpinnerIcon />
      <p
        data-testid="wizard-creating-label"
        style={{ margin: 0, fontSize: 'var(--font-body)', color: 'var(--text-secondary)', textAlign: 'center' }}
      >
        {label}
      </p>
      {/* 进度条（复用 UpdateBanner 的条形样式）：width 跟随 stage.ratio。 */}
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ height: 6, borderRadius: 'var(--radius-capsule)', overflow: 'hidden', background: 'var(--border-strong)' }}>
          <div
            data-testid="wizard-creating-progress-bar"
            style={{
              height: '100%',
              width: `${percent}%`,
              background: 'var(--accent)',
              transition: 'width var(--dur-slow) var(--ease)',
            }}
          />
        </div>
        <div style={{ fontSize: 'var(--font-caption)', textAlign: 'right', color: 'var(--text-secondary)' }}>
          {percent}%
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        {operationId && !cancelConfirming && (
          <button
            type="button"
            data-testid="wizard-cancel"
            onClick={onCancelRequest}
            disabled={cancelling}
            style={{ padding: '8px 16px', borderRadius: 'var(--radius-control)', border: '1px solid var(--danger)', background: 'transparent', color: 'var(--danger)', cursor: cancelling ? 'default' : 'pointer' }}
          >
            {cancelling ? t('wizard.cancelling') : t('wizard.cancelCreate')}
          </button>
        )}
        {operationId && cancelConfirming && (
          <div data-testid="wizard-cancel-confirm" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <span style={{ fontSize: 'var(--font-body)', color: 'var(--danger)' }}>{t('wizard.cancelWarning')}</span>
            <button type="button" onClick={onCancelConfirm} disabled={cancelling} style={{ padding: '8px 12px', borderRadius: 'var(--radius-control)', border: 'none', background: 'var(--danger)', color: 'var(--color-white)', cursor: cancelling ? 'default' : 'pointer' }}>
              {cancelling ? t('wizard.cancelling') : t('wizard.confirmCancel')}
            </button>
            <button type="button" data-testid="wizard-cancel-abort" onClick={onCancelAbort} disabled={cancelling} style={{ padding: '8px 12px', borderRadius: 'var(--radius-control)', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: cancelling ? 'default' : 'pointer' }}>
              {t('wizard.continueCreate')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function CancellationRecoveryStep({
  operationId,
  cancelling,
  confirming,
  available,
  onRequest,
  onConfirm,
  onAbort,
}: {
  operationId: string
  cancelling: boolean
  confirming: boolean
  available: boolean
  onRequest: () => void
  onConfirm: () => void
  onAbort: () => void
}) {
  const { t } = useTranslation('agents')
  return (
    <div data-testid="wizard-cancellation-recovery" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '28px 0' }}>
      <div>
        <h3 style={{ margin: '0 0 8px', fontSize: 'var(--font-title)', lineHeight: 'var(--lh-title)', fontWeight: 600 }}>{t('wizard.recoveryTitle')}</h3>
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--font-body)', lineHeight: 1.6 }}>
          {t('wizard.recoveryBody')}
        </p>
      </div>
      {!available && (
        <div style={{ color: 'var(--danger)', fontSize: 'var(--font-body)' }}>
          {t('wizard.recoveryUnavailable', { operationId })}
        </div>
      )}
      {available && !confirming && (
        <button
          type="button"
          data-testid="wizard-continue-cancel"
          onClick={onRequest}
          disabled={cancelling}
          style={{ alignSelf: 'flex-start', padding: '8px 14px', borderRadius: 'var(--radius-control)', border: '1px solid var(--danger)', background: 'transparent', color: 'var(--danger)', cursor: cancelling ? 'default' : 'pointer' }}
        >
          {cancelling ? t('wizard.cancelling') : t('wizard.continueCancel')}
        </button>
      )}
      {available && confirming && (
        <div data-testid="wizard-cancel-confirm" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 'var(--font-body)', color: 'var(--danger)' }}>{t('wizard.continueCancelWarning')}</span>
          <button type="button" onClick={onConfirm} disabled={cancelling} style={{ padding: '8px 12px', borderRadius: 'var(--radius-control)', border: 'none', background: 'var(--danger)', color: 'var(--color-white)', cursor: cancelling ? 'default' : 'pointer' }}>
            {cancelling ? t('wizard.cancelling') : t('wizard.confirmContinueCancel')}
          </button>
          <button type="button" data-testid="wizard-cancel-abort" onClick={onAbort} disabled={cancelling} style={{ padding: '8px 12px', borderRadius: 'var(--radius-control)', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: cancelling ? 'default' : 'pointer' }}>
            {t('wizard.postpone')}
          </button>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step: done
// ─────────────────────────────────────────────────────────────────────────────

function DoneStep({ team, onClose }: { team: AgentTeam; onClose: () => void }) {
  const { t } = useTranslation('agents')
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 16,
        padding: '24px 0',
        textAlign: 'center',
      }}
    >
      {/* i18next-instrument-ignore-next-line -- decorative symbol */}
      <span style={{ fontSize: 40 }}>🎉</span>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
        {t('wizard.doneTitle')}
      </h2>
      <p style={{ margin: 0, fontSize: 'var(--font-body)', color: 'var(--text-secondary)' }}>
        {t('wizard.doneBody', { teamName: team.teamName, count: team.members.length })}
      </p>
      <button
        type="button"
        onClick={onClose}
        style={{
          marginTop: 8,
          padding: '8px 24px',
          borderRadius: 'var(--radius-control)',
          border: 'none',
          background: 'var(--accent)',
          color: 'var(--text-on-accent)',
          fontSize: 'var(--font-body)',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        {t('wizard.done')}
      </button>
    </div>
  )
}

function cancellationRecoveryOperationId(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'TeamCancellationRecoveryRequiredError') return undefined
  const operationId = (error as Error & { operationId?: unknown }).operationId
  return typeof operationId === 'string' && operationId.length > 0 ? operationId : undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

const wizardLog = rendererLogger('agents/build-wizard')

export function BuildAgentWizard({ onGenerate, onCreate, onCreated, onClose, onCancel, initialDescription, initialTeam, initialCancellationOperationId }: BuildAgentWizardProps) {
  const { t, i18n } = useTranslation('agents')
  const { theme } = useTheme()
  // 预设团队直接进「预览」；否则从「描述」起步。
  const [step, setStep] = useState<Step>(initialCancellationOperationId ? 'cancellation-recovery' : initialTeam ? 'preview' : 'describe')
  const [team, setTeam] = useState<AgentTeam | null>(initialTeam ?? null)
  const [error, setError] = useState<string | null>(null)
  // #1981 创建中的分阶段进度（createAgentTeam 经 onProgress 回填）；null = 尚无进度事件 → 不确定态。
  const [stage, setStage] = useState<CreateTeamProgress | null>(null)
  const [operationId, setOperationId] = useState<string | null>(initialCancellationOperationId ?? null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelConfirming, setCancelConfirming] = useState(false)
  const [creationTools, setCreationTools] = useState<readonly LocalAgentCreationTool[]>(() =>
    platform.kind === 'electron' ? [] : LOCAL_AGENT_CREATION_TOOLS,
  )
  const createAttemptRef = useRef(0)

  useEffect(() => {
    let active = true
    void loadLocalAgentCreationTools(platform)
      .then((tools) => {
        if (active) setCreationTools(tools)
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [])

  // 如果调用方没有注入自定义 onGenerate，使用内置 LLM 实现
  const generate = onGenerate ?? generateAgentTeam

  const stepDotCurrent: 'describe' | 'preview' | 'done' =
    step === 'describe' || step === 'generating'
      ? 'describe'
      : step === 'preview' || step === 'creating'
        ? 'preview'
        : 'done'

  const handleGenerate = useCallback(
    async (desc: string) => {
      setError(null)
      setStep('generating')
      try {
        const result = await generate(desc)
        setTeam(result)
        setStep('preview')
      } catch (err) {
        setError(err instanceof Error ? err.message : t('wizard.generateFailed'))
        setStep('describe')
      }
    },
    [generate, t],
  )

  const handleCreate = useCallback(async () => {
    if (!team) return
    const attempt = createAttemptRef.current + 1
    createAttemptRef.current = attempt
    setOperationId(null)
    setCancelConfirming(false)
    setCancelling(false)
    setStage(null) // #1981 清掉上次失败残留的进度，重进创建态从不确定态起步
    setStep('creating')
    setError(null)
    const handleProgress = (progress: CreateTeamProgress) => {
      if (progress.operationId) setOperationId(progress.operationId)
      setStage(progress)
    }
    try {
      const result = await onCreate(team, handleProgress)
      if (createAttemptRef.current !== attempt) return
      if (result && result.handoffOwner !== false) {
        const handoffTeam = Object.prototype.hasOwnProperty.call(result, 'starterPrompt')
          ? { ...team, starterPrompt: result.starterPrompt }
          : team
        try {
          if (onCreated) await onCreated(handoffTeam, result)
          result.finishHandoff?.(true)
        } catch (error) {
          result.finishHandoff?.(false)
          throw error
        }
      }
      if (createAttemptRef.current !== attempt) return
      setStep('done')
    } catch (err) {
      if (createAttemptRef.current !== attempt) return
      const recoveryOperationId = cancellationRecoveryOperationId(err)
      if (recoveryOperationId) {
        setOperationId(recoveryOperationId)
        setCancelConfirming(false)
        setCancelling(false)
        wizardLog.error(
          { err: err instanceof Error ? err.message : String(err), operationId: recoveryOperationId },
          'agent wizard needs cancellation recovery',
        )
        setError(t('wizard.cancellationPending'))
        setStep('cancellation-recovery')
        return
      }
      wizardLog.error({ err: err instanceof Error ? err.message : String(err) }, 'agent wizard create failed')
      setError(t('wizard.createFailed'))
      setStep('preview')
    }
  }, [team, onCreate, onCreated, t])

  const handleCancelRequest = useCallback(() => {
    if (operationId && onCancel && !cancelling) setCancelConfirming(true)
  }, [cancelling, onCancel, operationId])

  const handleCancelConfirm = useCallback(async () => {
    if (!operationId || !onCancel || cancelling) return
    const cancelledOperationId = operationId
    setCancelling(true)
    setError(null)
    try {
      const result = await onCancel(cancelledOperationId)
      if (result.completedNoop) {
        if (step === 'cancellation-recovery') {
          setError(t('wizard.completedDuringRecovery', { operationId: cancelledOperationId }))
          setCancelConfirming(false)
          setCancelling(false)
          return
        }
        // finalize won the race. This was not a cancellation: preserve the in-flight onCreated/draft/navigation
        // handoff and never invalidate its attempt generation or overwrite it with a misleading cancel state.
        setCancelConfirming(false)
        setCancelling(false)
        return
      }
      createAttemptRef.current += 1 // an actual cancel now owns the attempt; late drive resolve/reject is stale
      if (result.fullyCancelled) {
        setOperationId(null)
        setCancelConfirming(false)
        setCancelling(false)
        if (result.cleanupErrors.length > 0) {
          wizardLog.warn({ cleanupErrors: result.cleanupErrors.join('; ') }, 'agent wizard cleanup reported warnings')
        }
        const warning = result.cleanupErrors.length > 0
          ? t('wizard.cleanupWarning', { steps: cleanupStepsText(result.cleanupStages, t, i18n.language) })
          : ''
        setError(t('wizard.cancelled', { warning }))
        setStep('preview')
      } else {
        if (result.cleanupErrors.length > 0) {
          wizardLog.warn({ cleanupErrors: result.cleanupErrors.join('; ') }, 'agent wizard cancellation still pending')
        }
        setError(result.cleanupStages.length > 0
          ? t('wizard.cancellationPendingSteps', { steps: cleanupStepsText(result.cleanupStages, t, i18n.language) })
          : t('wizard.cancellationPending'))
        setCancelConfirming(false)
        setCancelling(false)
        setStep('cancellation-recovery')
      }
    } catch (err) {
      wizardLog.error({ err: err instanceof Error ? err.message : String(err) }, 'agent wizard cancel failed')
      setError(err instanceof Error ? t('wizard.cancelFailed') : t('wizard.cancelFailedRetry'))
      setCancelConfirming(false)
      setCancelling(false)
    }
  }, [cancelling, i18n.language, onCancel, operationId, step, t])

  const handleCancelAbort = useCallback(() => {
    if (!cancelling) setCancelConfirming(false)
  }, [cancelling])

  const handleMemberEngineChange = useCallback((memberId: string, engineId: SelectableAgentType) => {
    setTeam((current) => current ? {
      ...current,
      members: current.members.map((member) =>
        member.tempId === memberId ? { ...member, engineId } : member,
      ),
    } : current)
  }, [])

  const handleStarterPromptChange = useCallback((starterPrompt: string) => {
    setTeam((current) => current ? { ...current, starterPrompt } : current)
  }, [])

  return (
    <SessionUiThemeProvider theme={theme} target="documentElement">
      <>
      {/* inject keyframe for spinner; scoped via data attr to avoid global pollution */}
      <style>{`
        @keyframes wizardSpin {
          to { transform: rotate(360deg); }
        }
      `}</style>

      <Sheet
        onClose={onClose}
        onEscape={step === 'creating' ? () => true : undefined}
        closeOnBackdrop={step !== 'creating'}
        desktopWidth="min(480px, 100%)"
        desktopMaxHeight="min(90vh, calc(100dvh - 32px))"
        mobileFitContent
        testId="build-agent-wizard"
        ariaLabel={t('wizard.ariaLabel')}
      >
        <div
          style={{
            padding: '28px 28px 24px',
            minHeight: 0,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            position: 'relative',
          }}
        >
          {/* Close button */}
          {step !== 'creating' && <button
            type="button"
            onClick={onClose}
            aria-label={t('wizard.close')}
            style={{
              position: 'absolute',
              top: 16,
              right: 16,
              width: 28,
              height: 28,
              borderRadius: 'var(--radius-circle)',
              border: 'none',
              background: 'var(--bg-elevated)',
              color: 'var(--text-secondary)',
              fontSize: 'var(--font-heading)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
            }}
          >
            ×
          </button>}

          {step !== 'done' && step !== 'cancellation-recovery' && <StepDots current={stepDotCurrent} />}

          {error && (
            <div
              data-testid="wizard-error"
              style={{
                padding: '8px 12px',
                borderRadius: 'var(--radius-control)',
                background: 'var(--danger-tint)',
                color: 'var(--danger)',
                fontSize: 'var(--font-body)',
                marginBottom: 8,
              }}
            >
              {error}
            </div>
          )}

          {step === 'describe' && (
            <DescribeStep onSubmit={handleGenerate} initialDescription={initialDescription} />
          )}
          {step === 'generating' && <GeneratingStep />}
          {step === 'preview' && team && (
            <PreviewStep
              team={team}
              onBack={initialTeam ? onClose : () => setStep('describe')}
              onConfirm={handleCreate}
              onEngineChange={handleMemberEngineChange}
              tools={creationTools}
              onStarterPromptChange={handleStarterPromptChange}
              summaryLabel={initialTeam ? t('wizard.presetSummary') : undefined}
              backLabel={initialTeam ? t('common.cancel') : t('wizard.regenerate')}
            />
          )}
          {step === 'creating' && team && (
            <CreatingStep
              teamName={team.teamName}
              stage={stage}
              operationId={onCancel ? operationId : null}
              cancelling={cancelling}
              cancelConfirming={cancelConfirming}
              onCancelRequest={handleCancelRequest}
              onCancelConfirm={handleCancelConfirm}
              onCancelAbort={handleCancelAbort}
            />
          )}
          {step === 'cancellation-recovery' && operationId && (
            <CancellationRecoveryStep
              operationId={operationId}
              cancelling={cancelling}
              confirming={cancelConfirming}
              available={Boolean(onCancel)}
              onRequest={handleCancelRequest}
              onConfirm={handleCancelConfirm}
              onAbort={handleCancelAbort}
            />
          )}
          {step === 'done' && team && <DoneStep team={team} onClose={onClose} />}
        </div>
      </Sheet>
      </>
    </SessionUiThemeProvider>
  )
}
