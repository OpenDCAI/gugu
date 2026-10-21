import { BODY_COLORS } from '../components/agentAvatar/engine/identity'
import { parseAgentLook, resolveAgentLook } from '../components/agentAvatar/look'

/**
 * #7199 助理 App 的主题色 = 它那只小鸟的身体颜色(引导里「选主题色」选的就是它,存在头像字段的形象地址里;形象工坊里换了也跟着变)。
 * 只交色相:明度 / 彩度由 `--ta-tint*` token 按亮暗定(assistant-today.css)。头像是照片 = 没有小鸟颜色 → undefined(走咕咕默认色)。
 */
export function assistantTintHue(id: string | null | undefined, avatar: string | null | undefined): number | undefined {
  if (avatar && !parseAgentLook(avatar)) return undefined
  return BODY_COLORS[resolveAgentLook(id, avatar).color]?.hue
}

/** 挂在 `.ta-app` / `.ta-phone` 根上的那一格;没有色相 = 不写(走默认)。 */
export function assistantTintStyle(hue: number | undefined): Record<string, number> | undefined {
  return hue === undefined ? undefined : { '--ta-tint-h': hue }
}
