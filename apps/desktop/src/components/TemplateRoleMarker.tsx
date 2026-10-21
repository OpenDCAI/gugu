import { Compass, Search, Shield, Sparkles, Lightbulb, Checklist, Tag, Zap } from '../lib/icons'

// @@@2470 模板角色标记 —— 一个**显式的非身份**视觉。
//
// 预设团队卡片与组建向导里的成员，在「组建之前」还不是身份：它没有 agent id，也不该被用户
// 读成「这个 agent 将来长这样」。所以这里刻意**不用** Avatar（圆形的身份投影），改用紧凑的
// 圆角方形标记 + 现有图标集里的角色字形 —— 形状上一眼就能与身份头像区分开。
//
// 组建完成后，真身份一律按稳定的 agent id 取脸；模板 key 不会被带进最终身份
// （它是「每个角色一个」，同一模板可被组建 N 次，拿它当身份 seed 会让所有团队的同名角色撞脸）。
const ROLE_GLYPHS = [Compass, Search, Shield, Sparkles, Lightbulb, Checklist, Tag, Zap] as const

/** 确定性挑一个字形：同一个角色 key 永远同一个字形，与显示名解耦（改名不变）。 */
function glyphFor(roleKey: string) {
  let hash = 0
  for (let i = 0; i < roleKey.length; i += 1) hash = (hash * 31 + roleKey.charCodeAt(i)) >>> 0
  return ROLE_GLYPHS[hash % ROLE_GLYPHS.length]
}

export function TemplateRoleMarker({
  roleKey,
  templateLabel,
  size = 26,
}: {
  roleKey: string
  templateLabel: string
  size?: number
}) {
  // @@@2470 模板 key 缺失时 fail loud：不静默、更不用显示名兜（那会让模板美术随改名而变，
  // 也会让同名角色跨团队撞）。所有构造点都必须在 blueprint 边界给出稳定槽位 key。
  const key = (roleKey ?? '').trim()
  if (!key) throw new Error('[TemplateRoleMarker] requires a stable template/blueprint slot key')
  const Glyph = glyphFor(key)
  return (
    <span
      data-template-role-marker
      role="img"
      aria-label={templateLabel}
      title={templateLabel}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        // 圆角从 tokens 刻度取，不按尺寸算：size*0.28 在 26px 时算出 7px，
        // 而刻度是 4/6/8/12 —— 一个页面上 45 个标记全落在刻度外。
        // 形状语义不变：仍是「圆角方形」，与圆形身份头像一眼可分（@@@2470）。
        borderRadius: size >= 40 ? 'var(--radius-xl)' : size >= 20 ? 'var(--radius-control)' : 'var(--radius-sm)',
        background: 'transparent',
        border: '1px solid var(--border-subtle)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-tertiary)',
        boxSizing: 'border-box',
      }}
    >
      <Glyph size={Math.round(size * 0.56)} />
    </span>
  )
}
