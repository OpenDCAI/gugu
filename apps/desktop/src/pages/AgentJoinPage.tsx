/**
 * AgentJoinPage — 公开 agent 落地页 (#900 / #902)
 *
 * 完全 props 驱动；调用方负责数据加载与路由。
 *
 * 路由接入点（供 App.tsx 将来注册）：
 *   /join/agent/:id   或   /join/agent?share_token=<token>
 *
 * 数据来源：调用方从 `agent_profiles` 表（或公开 RPC）按
 * share_token / agent_id 拉取后注入 `agent` prop。
 * share_token 本身保留在 URL 参数层，不进本组件。
 */

import type { AgentCategory } from '@gugu/core/shared/enums/agentCategories'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../components/Avatar'
import { customAvatarUrl } from '../lib/dicebearAvatar'
import { resolveCategoryLabel, clampBio } from './agentJoinUtils'

// ── Props ─────────────────────────────────────────────────────────────────────

/** agent 信息对象——由父层从 DB / RPC 拉取后传入 */
export interface AgentJoinInfo {
  /** agent 的 users.id */
  id: string
  /** 展示名称 */
  displayName: string
  /** 头像 URL（可为 null） */
  avatar: string | null
  /** 简介 */
  bio: string | null
  /** owner 展示名称 */
  ownerDisplayName: string | null
  /** owner 头像（可为 null） */
  ownerAvatar?: string | null
  /** 分类枚举值，来自 agent_profiles.category */
  category?: AgentCategory | string | null
  /** 能力标签（自由文本数组，来自 agent_profiles.capabilities 等字段） */
  capabilities?: string[]
}

export interface AgentJoinPageProps {
  /** 要展示的 agent 信息 */
  agent: AgentJoinInfo
  /**
   * 用户已登录时点击「开始对话」触发。
   * 父层负责跳转到对话界面或发起 befriend 请求。
   */
  onStartChat: (agentId: string) => void
  /**
   * 用户未登录时点击 CTA 触发。
   * 父层负责跳转登录页或弹出登录弹窗。
   */
  onRequireLogin: () => void
  /**
   * 当前用户是否已登录。
   * true  → 显示「开始对话」
   * false → 显示「登录后对话」
   */
  isLoggedIn: boolean
  /** 加载态：展示骨架占位 */
  loading?: boolean
  /** 错误态：展示错误提示 */
  error?: string | null
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Skeleton() {
  const pulse: React.CSSProperties = {
    // @@@6105 原来是 rgba(255,255,255,0.06):页面底是 --bg-primary(亮色=白),
    // 于是整个骨架屏在亮色主题下看不见。改走语义面色。
    background: 'var(--bg-elevated)',
    borderRadius: 'var(--radius-control)',
    animation: 'agentjoin-pulse 1.4s ease-in-out infinite',
  }
  return (
    <div style={{ padding: '40px 24px', maxWidth: 480, margin: '0 auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div style={{ ...pulse, width: 80, height: 80, borderRadius: 'var(--radius-circle)' }} />
        <div style={{ ...pulse, width: 160, height: 20 }} />
        <div style={{ ...pulse, width: 240, height: 14 }} />
        <div style={{ ...pulse, width: '100%', height: 64, marginTop: 8 }} />
        <div style={{ ...pulse, width: '100%', height: 44, marginTop: 8 }} />
      </div>
    </div>
  )
}

function CategoryBadge({ label }: { label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        // 2026-09-22 按 design.md 统一:「colored category chips」在反对清单上,而这抹橙
        // 不表达任何状态 ⇒ 纯装饰的第二个 accent。改成墨色 8px 矩形,层级靠字重与留白。
        padding: '2px 10px',
        borderRadius: 'var(--radius-control)',
        background: 'var(--bg-elevated)',
        color: 'var(--text-secondary)',
        fontSize: 'var(--font-size-xs)',
        fontWeight: 'var(--font-weight-medium)',
        lineHeight: 1.6,
        border: '1px solid var(--border)',
      }}
    >
      {label}
    </span>
  )
}

function CapabilityTag({ label }: { label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 10px',
        borderRadius: 'var(--radius-control)',
        background: 'var(--bg-elevated)',
        color: 'var(--text-secondary)',
        fontSize: 'var(--font-size-xs)',
        lineHeight: 1.6,
        border: '1px solid var(--border-color)',
      }}
    >
      {label}
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function AgentJoinPage({
  agent,
  onStartChat,
  onRequireLogin,
  isLoggedIn,
  loading = false,
  error = null,
}: AgentJoinPageProps) {
  const { t } = useTranslation('agents')
  const categoryLabel = resolveCategoryLabel(agent.category)
  // @@@2470 只有**真上传的**头像才配出现在署名行。走共享入口 customAvatarUrl —— 自己内联
  // normalize 会漏掉脏哨兵诊断：署名行本就不渲染 Avatar，
  // 那条 report 再不在这里发，"undefined" 这类上游 bug 就彻底静默了（review3 F4）。
  const ownerCustomAvatar = customAvatarUrl(agent.ownerAvatar, 'public join owner byline')
  const bioPreview = clampBio(agent.bio, 280)
  const capabilities = agent.capabilities ?? []

  return (
    <div
      data-page="agent-join"
      style={{
        minHeight: '100vh',
        background: 'var(--bg-primary)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        padding: '48px 16px 64px',
        boxSizing: 'border-box',
        fontFamily: 'var(--font-family-system)',
        color: 'var(--text-primary)',
      }}
    >
      {/* Keyframe: defined inline once, no external CSS dependency */}
      <style>{`
        @keyframes agentjoin-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        /* @@@2322 CTA hover:命令式 onMouseEnter 改 style → 类;透明度逐值保持现状
           (0.85/0.8 是本页既有档,非 gg-fill 的 0.88,故用组件类不挂 gg-fill)。 */
        .agentjoin-cta:hover { opacity: 0.85; }
        .agentjoin-cta--login:hover { opacity: 0.8; }
      `}</style>

      {loading ? (
        <Skeleton />
      ) : error ? (
        <div
          role="alert"
          style={{
            marginTop: 80,
            padding: '24px 32px',
            borderRadius: 'var(--radius-xl)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-color)',
            color: 'var(--text-secondary)',
            fontSize: 'var(--font-size-sm)',
            textAlign: 'center',
            maxWidth: 360,
          }}
        >
          {error}
        </div>
      ) : (
        <div
          style={{
            width: '100%',
            maxWidth: 480,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 0,
          }}
        >
          {/* ── Agent head ── */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <Avatar
              name={agent.displayName}
              avatarUrl={agent.avatar}
              seed={agent.id}
              size="lg"
              isAgent
            />
            <h1
              style={{
                margin: 0,
                fontSize: 'var(--font-size-xl)',
                fontWeight: 'var(--font-weight-semibold)',
                lineHeight: 1.2,
                textAlign: 'center',
                color: 'var(--text-primary)',
              }}
            >
              {agent.displayName}
            </h1>
            {categoryLabel && (
              <CategoryBadge label={categoryLabel} />
            )}
          </div>

          {/* ── Owner row ── */}
          {agent.ownerDisplayName && (
            <div
              style={{
                marginTop: 16,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {/* @@@2470 owner 行是**署名**，不是身份投影。owner 真上传过头像就逐字渲染；
                  没有就整个去掉头像位，只留名字 —— 不给空圈、不生成脸、不用首字母兜底。
                  （公开 join payload 里没有 owner id，也不该为了造一张脸把它暴露出去。） */}
              {ownerCustomAvatar ? (
                <Avatar name={agent.ownerDisplayName} avatarUrl={ownerCustomAvatar} size="sm" />
              ) : null}
              <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)' }}>
                {t('public.ownerCreatedPrefix')}&nbsp;
                <span style={{ color: 'var(--text-primary)', fontWeight: 'var(--font-weight-medium)' }}>
                  {agent.ownerDisplayName}
                </span>
                &nbsp;{t('public.ownerCreatedSuffix')}
              </span>
            </div>
          )}

          {/* ── Bio ── */}
          {bioPreview && (
            <p
              style={{
                marginTop: 24,
                marginBottom: 0,
                padding: '16px 20px',
                background: 'var(--bg-elevated)',
                borderRadius: 'var(--radius-xl)',
                border: '1px solid var(--border-color)',
                fontSize: 'var(--font-size-sm)',
                lineHeight: 'var(--line-height-base)',
                color: 'var(--text-secondary)',
                width: '100%',
                boxSizing: 'border-box',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {bioPreview}
            </p>
          )}

          {/* ── Capabilities ── */}
          {capabilities.length > 0 && (
            <div style={{ marginTop: 20, width: '100%' }}>
              <p
                style={{
                  margin: '0 0 8px',
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--text-tertiary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  fontWeight: 'var(--font-weight-medium)',
                }}
              >
                {t('public.capabilities')}
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {capabilities.map((cap) => (
                  <CapabilityTag key={cap} label={cap} />
                ))}
              </div>
            </div>
          )}

          {/* ── CTA ── */}
          <div style={{ marginTop: 32, width: '100%' }}>
            {isLoggedIn ? (
              <button
                type="button"
                onClick={() => onStartChat(agent.id)}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '14px 0',
                  borderRadius: 'var(--radius-xl)',
                  background: 'var(--accent)',
                  color: 'var(--text-on-accent)',
                  fontSize: 'var(--font-size-md)',
                  fontWeight: 'var(--font-weight-semibold)',
                  fontFamily: 'var(--font-family-system)',
                  border: 'none',
                  cursor: 'pointer',
                  letterSpacing: '0.01em',
                  transition: 'opacity var(--transition-fast)',
                }}
                className="agentjoin-cta"
              >
                {t('public.startChat')}
              </button>
            ) : (
              <button
                type="button"
                onClick={onRequireLogin}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '14px 0',
                  borderRadius: 'var(--radius-xl)',
                  // 2026-09-22 按 design.md 统一:同一页两个 CTA 原来是两套色系
                  //(已登录走 --accent 墨、未登录走硬编码橙)⇒「One accent at a time」。
                  // 次级 CTA 改成空心 + 一条发丝边,不另起一个色系。
                  background: 'transparent',
                  color: 'var(--text-primary)',
                  fontSize: 'var(--font-size-md)',
                  fontWeight: 'var(--font-weight-semibold)',
                  fontFamily: 'var(--font-family-system)',
                  border: '1px solid var(--border-strong)',
                  cursor: 'pointer',
                  letterSpacing: '0.01em',
                  transition: 'opacity var(--transition-fast)',
                }}
                className="agentjoin-cta agentjoin-cta--login"
              >
                {t('public.loginToChat')}
              </button>
            )}
          </div>

          {/* ── Disclaimer ── */}
          <p
            style={{
              marginTop: 16,
              fontSize: 'var(--font-size-xs)',
              color: 'var(--text-tertiary)',
              textAlign: 'center',
              lineHeight: 1.5,
            }}
          >
            {t('public.disclaimer')}
          </p>
        </div>
      )}
    </div>
  )
}
