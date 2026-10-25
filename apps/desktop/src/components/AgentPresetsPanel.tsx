/**
 * AgentPresetsPanel — Agent Preset 模板库面板
 *
 * 范围：不做 admin 上传 / tar.gz 导入 / 多语言 / 版本管理；
 *
 * 纯展示组件，props 驱动：
 *   presets[]    ← 数据在 identity.agent_presets 表（schema/seed 见 gugu-supabase 的 supabase/migrations 的
 *                  20260615031000_agent_presets / 20260618120000_seed_agent_presets）。
 *                  原 fetcher lib/agentPresets.ts 已删（#1900）：#1788 统一创建流重写
 *                  CreateAgentModal 后本面板无挂载点，fetcher 成孤儿；复活时按迁移 schema 重写即可。
 *   onSelect(p)  ← 由未来挂载方接住，预填「具体目标」spec（persona_template ?? description）
 *   onClose()    → void
 *
 * 样式沿用 gugu UI token：var(--accent)/var(--text-*)/var(--border-color)/var(--bg-*)
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SearchField } from './ui/SearchField'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentPreset {
  id: string
  name: string
  description: string
  /** 例如 ['coding', 'productivity'] */
  tags: string[]
  /** 展示用 emoji 图标（identity.agent_presets.icon_emoji） */
  iconEmoji?: string
  /**
   * Persona 模板正文（identity.agent_presets.persona_template）。
   * 面板不渲染，仅供 onSelect 带入建 agent 流程预填「具体目标」spec；NULL → 回落 description。
   */
  personaTemplate?: string
}

export interface AgentPresetsPanelProps {
  presets: AgentPreset[]
  loading?: boolean
  error?: string
  /**
   * 用户点击「使用」后回调；CreateAgentModal 用 preset 预填「具体目标」spec。
   */
  onSelect: (preset: AgentPreset) => void
  onClose: () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function TagBadge({ tag }: { tag: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 'var(--radius-document)',
        fontSize: 'var(--font-caption)',
        fontWeight: 500,
        background: 'var(--bg-elevated)',
        color: 'var(--text-secondary)',
        lineHeight: '18px',
      }}
    >
      {tag}
    </span>
  )
}

function SkeletonCard() {
  return (
    <div
      style={{
        padding: '14px 16px',
        borderRadius: 'var(--radius-xl)',
        border: '1px solid var(--border-color)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          width: 100,
          height: 14,
          borderRadius: 'var(--radius-document)',
          background: 'var(--color-bg-chat-list)',
          animation: 'presetPulse 1.4s ease infinite',
        }}
      />
      <div
        style={{
          width: '80%',
          height: 12,
          borderRadius: 'var(--radius-document)',
          background: 'var(--color-bg-chat-list)',
          animation: 'presetPulse 1.4s ease infinite',
        }}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        {[60, 50].map((w) => (
          <div
            key={w}
            style={{
              width: w,
              height: 20,
              borderRadius: 'var(--radius-document)',
              background: 'var(--color-bg-chat-list)',
              animation: 'presetPulse 1.4s ease infinite',
            }}
          />
        ))}
      </div>
    </div>
  )
}

function PresetCard({
  preset,
  onSelect,
}: {
  preset: AgentPreset
  onSelect: () => void
}) {
  const { t } = useTranslation('agents')
  return (
    // @@@2322 P2.5 — 删 JS hover → CSS hover 类;边框/底色逐值保留(1px→1.5px 加粗即原行为)
    <div
      className="border border-[var(--border-color)] bg-[var(--bg-elevated)] hover:border-[1.5px] hover:border-[var(--accent)] hover:bg-[var(--bg-elevated)]"
      style={{
        padding: '14px 16px',
        borderRadius: 'var(--radius-xl)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        transition: 'border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease)',
        cursor: 'default',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {preset.iconEmoji && (
          <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }}>
            {preset.iconEmoji}
          </span>
        )}
        <span
          style={{
            fontWeight: 600,
            fontSize: 'var(--font-body)',
            color: 'var(--text-primary)',
            flex: 1,
            minWidth: 0,
          }}
        >
          {preset.name}
        </span>
        <button
          type="button"
          onClick={onSelect}
          style={{
            padding: '4px 12px',
            borderRadius: 'var(--radius-document)',
            border: 'none',
            background: 'var(--accent)',
            color: 'var(--text-on-accent)',
            fontSize: 'var(--font-body)',
            fontWeight: 600,
            cursor: 'pointer',
            flexShrink: 0,
            transition: 'opacity var(--dur-fast) var(--ease)',
          }}
        >
          {t('presets.use')}
        </button>
      </div>

      {/* Description */}
      <p
        style={{
          margin: 0,
          fontSize: 'var(--font-body)',
          color: 'var(--text-secondary)',
          lineHeight: 1.5,
        }}
      >
        {preset.description}
      </p>

      {/* Tags */}
      {preset.tags.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {preset.tags.map((t) => (
            <TagBadge key={t} tag={t} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Search/filter bar
// ─────────────────────────────────────────────────────────────────────────────

function SearchBar({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { t } = useTranslation('agents')
  return (
    <SearchField
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={t('presets.search')}
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function AgentPresetsPanel({
  presets,
  loading = false,
  error,
  onSelect,
  onClose,
}: AgentPresetsPanelProps) {
  const { t } = useTranslation('agents')
  const [query, setQuery] = useState('')

  const filtered = query.trim()
    ? presets.filter((p) => {
        const q = query.toLowerCase()
        return (
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q))
        )
      })
    : presets

  return (
    <>
      <style>{`
        @keyframes presetPulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
      `}</style>

      <div
        // 全窗口层:几何归 `.gg-window-layer`(tokens.css @@@window-layer),铺在 Windows 标题栏行下面。
        className="gg-window-layer"
        style={{
          background: 'var(--bg-overlay-modal)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 'var(--z-modal)',
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <div
          style={{
            background: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-dialog)', // #7333 对话框外壳 16(thread 现在是 composer 的 24)
            padding: '24px 24px 20px',
            width: '100%',
            maxWidth: 520,
            maxHeight: '85vh',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            // #7333 对话框外壳:dialog 那一档投影(菜单 / popover 才是 lift)。
            boxShadow: 'var(--shadow-dialog)',
            position: 'relative',
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2
              style={{
                margin: 0,
                // #7333 对话框标题 = 面板标题角色 16/24 半粗(契约 v3.1)。
                fontSize: 'var(--font-title)',
                lineHeight: 'var(--lh-title)',
                fontWeight: 600,
                color: 'var(--text-primary)',
                flex: 1,
              }}
            >
              {t('presets.title')}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('presets.close')}
              style={{
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
            </button>
          </div>

          <SearchBar value={query} onChange={setQuery} />

          {/* Content area */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              paddingRight: 2, // room for scrollbar
            }}
          >
            {error && (
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-control)',
                  background: 'var(--danger-tint)',
                  color: 'var(--danger)',
                  fontSize: 'var(--font-body)',
                }}
              >
                {error}
              </div>
            )}

            {loading && (
              <>
                <SkeletonCard />
                <SkeletonCard />
                <SkeletonCard />
              </>
            )}

            {!loading && !error && filtered.length === 0 && (
              <div
                style={{
                  padding: '32px 0',
                  textAlign: 'center',
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--font-body)',
                }}
              >
                {query ? t('presets.noMatch') : t('presets.empty')}
              </div>
            )}

            {!loading &&
              filtered.map((p) => (
                <PresetCard
                  key={p.id}
                  preset={p}
                  onSelect={() => onSelect(p)}
                />
              ))}
          </div>

          {/* Footer hint */}
          {!loading && presets.length > 0 && (
            <p
              style={{
                margin: 0,
                fontSize: 'var(--font-caption)',
                color: 'var(--text-tertiary)',
                textAlign: 'center',
              }}
            >
              {t('presets.summary', { count: presets.length })}
            </p>
          )}
        </div>
      </div>
    </>
  )
}
