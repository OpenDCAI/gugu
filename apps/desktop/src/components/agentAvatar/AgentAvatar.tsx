import { useEffect, useId, useRef, type CSSProperties } from 'react'
import type { AgentStatusLabel } from '@gugu/core/shared/agentStatusPresentation'
import { rendererLogger } from '@/lib/log'
import { DEFAULT_CHARACTER } from './engine/characters'
import type { Crop } from './engine/draw'
import { runtime, type AvatarHandle } from './engine/runtime'
import type { DisplayStateId } from './engine/spec'
import { bodyTint } from './engine/identity'
import { wearKey } from './engine/outfitCatalog'
import { colorSlug, wornOf, type AgentLook } from './look'
import { useAgentLook } from './useAgentLook'

const log = rendererLogger('agent-avatar')

// 引擎的 14 个展示状态就是 presentAgentStatus 的 14 个 label,逐字同一份词表;两边任何一边多一个或少一个,
// 下面两行就编译不过 —— 不靠人记。
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
export const AGENT_AVATAR_STATES_MATCH: Same<AgentStatusLabel, DisplayStateId> = true

export interface AgentAvatarProps {
  /**
   * 稳定身份 id(agent 的 user id)。决定这只 agent 的形象(身体颜色 + 休息表情 + 装扮:存了就按存的,没存按 id 推,见 look.ts)
   * 与眨眼 / 小动作的相位:同一个 agent 在哪儿都长一个样,列表里的几只不会一起眨眼。
   * 还没有 agent 身份的格子(会话页里没开户的会话)传那一格自己的稳定 id(会话 id),❌ 传空串 —— 那会让它们全长成一个样。
   */
  id: string
  /** 明确给定的形象(形象工坊的草稿、没开户的会话按会话 id 推的);给了就不再去读存的。 */
  look?: AgentLook | null
  /** 调用方手里这只 agent 的头像地址:身份缓存里还没有它时,按这个读存着的形象。 */
  avatar?: string | null
  /** 一直挂着这张休息表情、不轮换(形象工坊里要看清选中的那张脸)。 */
  holdExpression?: boolean
  /** 每变一次就蹦一下(选中、掷骰子落定时的回应)。 */
  pulse?: number
  /** 读屏用的名字。 */
  name: string
  size: number
  /** 这一格状态(presentAgentStatus 的 label);null = 不演状态,只是本体在那儿。 */
  state?: AgentStatusLabel | null
  /** 取景:全身 / 半身。默认 < 40px 取半身(小圆里全身会缩成一撮)。 */
  crop?: Crop
  /** 眼睛跟光标。默认 ≥ 48px 才跟(列表里几十只一起转头只会吵)。 */
  tracking?: boolean
  /** 点一下拍一拍。默认关:头像外面常常包着「点开资料」的按钮。 */
  interactive?: boolean
  /** 鼠标移上去就被拍一拍(蹦一下、晃、眨眼、随机一个小反应),有冷却;点击照旧交给外面的按钮。单聊头栏那只用。 */
  hoverPoke?: boolean
  /** 星星 / 睡眠 z / 感叹号这类动效。默认 ≥ 40px 才有。 */
  fx?: boolean
  className?: string
}

/** 悬停拍一拍的冷却:一次反应(蹦 + 小表情)大约演 1.2s,演完才允许再拍。 */
const HOVER_POKE_COOLDOWN_MS = 1400

/** 稳定字符串 → 正整数种子(FNV-1a)。 */
function seedOf(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % 2147483647 || 1
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}

/**
 * agent 的头像:咕咕小鸟,状态靠身体自己变形来说(缩成三颗点、拉成「!」、塌成一滩……),不挂角标。
 * 一块 canvas;画什么由 engine/ 说了算,这里只负责挂载、尺寸与把 props 递给引擎。
 * 无背景、透明底:放在什么颜色上都成立。
 */
export function AgentAvatar({
  id,
  look: explicitLook,
  avatar,
  holdExpression = false,
  pulse,
  name,
  size,
  state = null,
  crop,
  tracking,
  interactive = false,
  hoverPoke = false,
  fx,
  className
}: AgentAvatarProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const handle = useRef<AvatarHandle | null>(null)
  const reactId = useId()
  const dpr = Math.min(2.5, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
  const px = Math.max(8, Math.round(size))
  const reduced = prefersReducedMotion()
  const opts = {
    shape: 'free' as const,
    bg: false,
    crop: crop ?? (px < 40 ? ('bust' as const) : ('full' as const)),
    fx: !reduced && (fx ?? px >= 40),
    tracking: !reduced && (tracking ?? px >= 48)
  }
  const gain = Math.min(1.8, Math.max(1, 1 + (110 - px) / 110))
  const look = useAgentLook(id, explicitLook, avatar)
  // 实际穿着:存了按存的,没存不戴装扮
  const worn = wornOf(look)
  const wear = wearKey(worn)
  const canvasStyle: CSSProperties = {
    width: px,
    height: px,
    display: 'block',
    flexShrink: 0,
    userSelect: 'none'
  }

  // 挂载一次:画布尺寸 + 注册进全局 rAF。id 变了(同一个格子换了个 agent)就重新注册,眨眼相位跟着换。
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    canvas.width = Math.round(px * dpr)
    canvas.height = Math.round(px * dpr)
    const h = runtime.register(canvas, opts, seedOf(id || reactId), dpr, DEFAULT_CHARACTER)
    if (!h) {
      log.error({ id }, 'canvas 2d context unavailable, avatar not drawn')
      return
    }
    handle.current = h
    h.engine.crop = opts.crop
    h.engine.gain = gain
    h.engine.rotate = !holdExpression
    h.engine.setExpression(look.rest)
    h.engine.setBodyColor(bodyTint(look.color))
    h.engine.setState(state)
    h.outfit.set(worn)
    return () => {
      runtime.unregister(h)
      handle.current = null
    }
    // 只在身份变化时重新注册;尺寸 / 状态 / 选项 / 形象各有自己的 effect 增量更新,不让重注册把动画重置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // 形象变了(主人改了、形象工坊里点了别的颜色 / 表情):颜色过渡过去,表情换上并演它的进场动作。
  useEffect(() => {
    const e = handle.current?.engine
    if (!e) return
    e.setExpression(look.rest)
    e.setBodyColor(bodyTint(look.color), true)
  }, [look.color, look.rest])

  // 换了一身装扮:新的一身素材到齐就换上(runtime 等它们,不先画光身)
  useEffect(() => {
    handle.current?.outfit.set(worn)
    // worn 每次都是新数组;真正决定换不换的是这一身的写法
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wear])

  useEffect(() => {
    if (handle.current) handle.current.engine.rotate = !holdExpression
  }, [holdExpression])

  useEffect(() => {
    if (pulse) handle.current?.engine.hop(0.32)
  }, [pulse])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const w = Math.round(px * dpr)
    if (canvas.width !== w) {
      canvas.width = w
      canvas.height = w
    }
    if (handle.current) handle.current.engine.gain = gain
  }, [px, dpr, gain])

  useEffect(() => {
    handle.current?.engine.setState(state)
  }, [state])

  const { shape, bg, crop: cropOpt, fx: fxOpt, tracking: trackingOpt } = opts
  useEffect(() => {
    if (handle.current)
      handle.current.opts = { shape, bg, crop: cropOpt, fx: fxOpt, tracking: trackingOpt }
  }, [shape, bg, cropOpt, fxOpt, trackingOpt])

  // 悬停拍一拍:每次「移进来」算一次,冷却 HOVER_POKE_COOLDOWN_MS 内在上面晃不重复拍(否则光标一抖它就一直抖)。
  const lastHoverPoke = useRef(Number.NEGATIVE_INFINITY)
  const onHoverPoke = () => {
    const now = performance.now()
    if (now - lastHoverPoke.current < HOVER_POKE_COOLDOWN_MS) return
    lastHoverPoke.current = now
    handle.current?.engine.poke()
  }

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={name}
      draggable={false}
      className={className}
      data-agent-avatar=""
      data-agent-avatar-state={state ?? undefined}
      data-agent-avatar-color={colorSlug(look.color)}
      data-agent-avatar-rest={look.rest}
      data-agent-avatar-wear={wear || undefined}
      style={canvasStyle}
      onClick={interactive ? () => handle.current?.engine.poke() : undefined}
      onPointerEnter={hoverPoke ? onHoverPoke : undefined}
    />
  )
}
