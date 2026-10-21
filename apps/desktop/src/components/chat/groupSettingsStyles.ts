import type { CSSProperties } from 'react'

// @@@6418 群设置抽屉各页共用的几何。行距、字号、分区线沿用原 GroupMembersSection 的那一套
// (2026-09-22 design.md:行靠 padding 节奏,线只留在分区标题上),拆成多页后每页照用,❌ 各页各拍一套。
// 单独成文件:react-refresh 要求组件文件只导出组件。

export const settingsSectionLabelStyle: CSSProperties = {
  fontSize: 'var(--font-caption)', fontWeight: 600, color: 'var(--text-tertiary)', margin: '22px 0 4px', letterSpacing: '.02em', paddingTop: 22, borderTop: '1px solid var(--border)',
}
export const settingsRowStyle: CSSProperties = {
  display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, padding: '15px 0',
}
export const settingsCenteredRowStyle: CSSProperties = { ...settingsRowStyle, alignItems: 'center' }
export const settingsRowTitleStyle: CSSProperties = {
  fontSize: 'var(--font-body)', fontWeight: 500, color: 'var(--text-primary)',
}
export const settingsRowSubtitleStyle: CSSProperties = {
  fontSize: 'var(--font-body)', color: 'var(--text-tertiary)', marginTop: 3, lineHeight: 1.5,
}
export const settingsReadOnlyBoxStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)', padding: 13,
  fontSize: 'var(--font-body)', color: 'var(--text-secondary)', lineHeight: 1.6,
  background: 'var(--bg-elevated)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
}
export const settingsTextareaStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 180,
  border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)', padding: 13,
  fontSize: 'var(--font-body)', color: 'var(--text-secondary)', lineHeight: 1.6,
  background: 'var(--bg-elevated)', outline: 'none', fontFamily: 'inherit',
}
export const settingsInputStyle: CSSProperties = {
  width: 64, textAlign: 'right', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-control)', padding: '4px 8px',
  fontSize: 'var(--font-body)', color: 'var(--text-primary)', background: 'var(--bg-elevated)', outline: 'none', fontFamily: 'inherit',
}
export const settingsSelectStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-control)', padding: '6px 10px',
  fontSize: 'var(--font-body)', color: 'var(--text-primary)', background: 'var(--bg-elevated)',
  outline: 'none', fontFamily: 'inherit', cursor: 'pointer', flexShrink: 0,
}
export const settingsMutedTextStyle: CSSProperties = { fontSize: 'var(--font-body)', color: 'var(--text-tertiary)', flexShrink: 0 }
export const settingsErrorStyle: CSSProperties = { padding: '8px 0 0', fontSize: 'var(--font-caption)', color: 'var(--danger)' }
export const settingsBodyStyle: CSSProperties = { flex: 1, overflowY: 'auto', padding: '24px' }
export const settingsMobileBodyStyle: CSSProperties = { ...settingsBodyStyle, padding: '14px 16px max(24px, env(safe-area-inset-bottom))' }
