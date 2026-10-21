import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { colorOfDisplayStatus, labelOfDisplayStatus } from '@gugu/core/shared/ui/agentConversationStatusModels'
import type { AgentStatusLabel } from '@gugu/core/shared/agentStatusPresentation'
import { normalizeAvatarUrl, reportInvalidAvatarUrl } from '@gugu/core/shared/ui/avatarUrl'
import type { AgentDisplayStatus, GroupAvatarMember } from '@gugu/core/shared/types/chat'
import { dicebearAvatarDataUri } from '../lib/dicebearAvatar'
import { AgentNeedsUserGlyph } from './AgentNeedsUserGlyph'
import { AgentHarnessBadge } from './AgentHarnessIdentity'
import { AgentAvatar } from './agentAvatar/AgentAvatar'
import { colorSlug, parseAgentLook, type AgentLook } from './agentAvatar/look'
import { agentLookPoster, useAgentLookPoster, useAgentLookPostersVersion } from './agentAvatar/posters'
import { useAgentLook } from './agentAvatar/useAgentLook'

export interface AvatarProps {
  name: string
  avatarUrl?: string | null
  // @@@2470 没有自定义头像时的默认脸按这个**稳定身份 key** 生成（调用方传的 id：同一身份永远同一张脸、
  // 改名不变）。姓名**永远不得**当 seed；未传 key 就不造脸，进可诊断空态。
  seed?: string
  // @@@avatar-xs (#1102) - 18px 超小号,用于「运行中」内联指示器(设计稿 .typing .tav)。
  // @@@1323-m6 兼收数字 px：少数对齐 SSOT 的一次性尺寸(如账户头像 46×46，命名档无 46)，向后兼容。
  size?: 'xs' | 'sm' | 'md' | 'lg' | number
  isAgent?: boolean
  // Runtime status is separate from the persistent bottom-right harness identity.
  agentStatus?: AgentDisplayStatus
  // 精确的一格状态(presentAgentStatus 的 label:等你批准 / 等你回答 …)。给了就压过粗分类 agentStatus;
  // 只有咕咕小鸟(agent 没上传头像)会读它 —— 小鸟用身体变形说状态,粗分类说不出「在等什么」。
  statusLabel?: AgentStatusLabel
  // 右下角的 harness 品牌小图标。默认画;单聊头部那只大头像不画(头栏那句「状态 · 位置 · 引擎」已经说了引擎)。
  harnessBadge?: boolean
  // 鼠标移上去小鸟就被拍一拍(只对会动的小鸟生效;照片 / 真人 / 群不变)。单聊头栏那只大头像用。
  hoverPoke?: boolean
  // 静止:agent 的小鸟画成它那个颜色的定格图,不动、不占每帧的绘制(#7243:群聊消息旁一条消息一只,只数随消息涨)。
  // 定格说不出状态,状态改挂右上角角标(同上传了照片的 agent)。
  still?: boolean
  variant?: 'default' | 'group'
  imageMatteColor?: string
  // @@@member-avatars - WeChat-style composite source. When provided + variant='group'
  // + no avatarUrl, render members in a 1/2/3/4/3x3 layout. Up to 9 members shown.
  memberAvatars?: GroupAvatarMember[]
}

const SIZE_MAP = { xs: 18, sm: 32, md: 40, lg: 64 } as const
const AVATAR_STATUS_DOT_CLASS = 'av-status__dot relative motion-reduce:animate-none'
const AVATAR_STATUS_PULSE_CLASS = 'av-status__pulse pointer-events-none absolute -inset-0.5 rounded-full border-2 border-solid animate-[av-status-pulse_1.4s_ease-out_infinite] motion-reduce:animate-none'
const AVATAR_STATUS_PULSE_DELAY_CLASS = `${AVATAR_STATUS_PULSE_CLASS} av-status__pulse--delay [animation-delay:0.7s]`

// @@@ wechat-composite-layout — see git history for full context.
interface TileRect { x: number; y: number; w: number; h: number }

function compositeLayout(n: number): TileRect[] {
  if (n <= 0) return []
  if (n === 1) return [{ x: 0, y: 0, w: 1, h: 1 }]
  if (n === 2) return [
    { x: 0,   y: 0.25, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0.25, w: 0.5, h: 0.5 },
  ]
  if (n === 3) return [
    { x: 0.25, y: 0,   w: 0.5, h: 0.5 },
    { x: 0,    y: 0.5, w: 0.5, h: 0.5 },
    { x: 0.5,  y: 0.5, w: 0.5, h: 0.5 },
  ]
  if (n === 4) return [
    { x: 0,   y: 0,   w: 0.5, h: 0.5 },
    { x: 0.5, y: 0,   w: 0.5, h: 0.5 },
    { x: 0,   y: 0.5, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  ]
  // 5–9: 3×3 grid, filled BOTTOM-UP so partial top rows sit at the top, centered.
  const cap = Math.min(n, 9)
  const rows = Math.ceil(cap / 3)
  const cells = cap
  const cell = 1 / 3
  const out: TileRect[] = []
  let placed = 0
  for (let r = 0; r < rows; r++) {
    const remaining = cells - placed
    const inThisRow = r === 0 ? (remaining - (rows - 1) * 3) : 3
    // Centre this row horizontally inside the 3-column grid.
    const leftOffset = (3 - inThisRow) * cell / 2
    for (let c = 0; c < inThisRow; c++) {
      out.push({
        x: leftOffset + c * cell,
        y: r * cell,
        w: cell,
        h: cell,
      })
      placed++
    }
  }
  return out
}

function CompositeTile({
  rect,
  member,
  canvasPx,
  gapPx,
  radius,
}: {
  rect: TileRect
  member: GroupAvatarMember
  canvasPx: number
  gapPx: number
  radius: number
}) {
  const [failed, setFailed] = useState(false)
  const memberUrl = normalizeAvatarUrl(member.avatar)
  // 成员的头像是形象地址(agent 的颜色 + 表情 + 装扮)→ 组合格里画这个形象的定格(引擎画的,画好前是同色那张),不去加载那张图。
  useAgentLookPostersVersion()
  const memberLook = parseAgentLook(memberUrl)
  const customUrl = memberLook ? agentLookPoster(memberLook, (member.id ?? '').trim()) : memberUrl
  // 脏哨兵串（给了值但归一后为空）是上游 bug，与主 Avatar 同口径 fail loud —— 留空槽，
  // ❌ 不用生成脸盖掉（否则组合里显示一张正常的脸、本人自己的行却是错误态，必有一处在说谎）。
  const invalidExplicit = member.avatar != null && memberUrl == null
  useEffect(() => {
    reportInvalidAvatarUrl(member.avatar, `composite member "${member.name || member.id}"`)
  }, [member.avatar, member.id, member.name])
  // @@@1482 canonical URL 变化时重置失败态，避免上一个坏 URL 的 failed 压住新有效头像（同 Avatar 主组件）。
  useEffect(() => { setFailed(false) }, [customUrl])
  const useCustom = !!customUrl && !failed
  // 自定义头像加载失败 = 错误，留明确空槽而不是换成默认脸（#2383 的正确部分：不用另一张脸盖掉失败）。
  // seed 只认 member.id：姓名永不入 seed（改名会变脸、同名会撞脸）。缺 id 同样进空槽。
  // @@@2470 trim：纯空白 id 不是身份 key，必须留空槽而不是落到共用脸。
  const memberKey = (member.id ?? '').trim()
  const generatedUrl = customUrl || invalidExplicit || !memberKey ? null : dicebearAvatarDataUri(memberKey)
  // @@@composite-gap - shrink each tile by gapPx/2 on each side; the canvas background
  const half = gapPx / 2
  const w = Math.max(1, rect.w * canvasPx - gapPx)
  const h = Math.max(1, rect.h * canvasPx - gapPx)
  const tileStyle: React.CSSProperties = {
    position: 'absolute',
    left: rect.x * canvasPx + half,
    top: rect.y * canvasPx + half,
    width: w,
    height: h,
    borderRadius: Math.max(2, Math.round(radius * (rect.w + rect.h) / 2)),
    overflow: 'hidden',
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'white',
    fontSize: Math.max(8, Math.round(Math.min(w, h) * 0.5)),
    fontWeight: 600,
  }
  return (
    <span style={tileStyle}>
      {useCustom ? (
        <img
          src={customUrl!}
          alt={member.name}
          draggable={false}
          onError={() => { console.error(`[Avatar] failed to load custom member avatar for "${member.name || member.id}"`); setFailed(true) }}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : generatedUrl ? (
        <img
          src={generatedUrl}
          alt={member.name}
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <span data-avatar-empty aria-label={`${member.name} avatar unavailable`} style={{ width: '100%', height: '100%', display: 'block', background: 'var(--bg-elevated)' }} />
      )}
    </span>
  )
}

// @@@avatar-status-badge - top-right status indicator. Color and words come from the shared presentation
// (packages/core/src/shared/agentStatusPresentation.ts — one table for the session page, chat and phone). Motion uses
// Tailwind animation utilities plus global keyframes. working = solid dot + two staggered pulse rings; parked = the
// same color, still; needs_user = Solar exclamation glyph; idle/offline/removed = static dot.
function AgentStatusBadge({ status, size }: { status: AgentDisplayStatus; size: number }) {
  const { t } = useTranslation('common')
  const color = colorOfDisplayStatus(status) ?? 'transparent'
  const label = t(`agentStatus.${labelOfDisplayStatus(status)}`)
  const running = status === 'working'
  return (
    <div
      className={`av-status av-status--${status}`}
      role="img"
      aria-label={label}
      title={label}
      style={{
        position: 'absolute',
        top: -2,
        right: -2,
        width: size,
        height: size,
        borderRadius: 'var(--radius-circle)',
        background: 'transparent',
        border: '1.5px solid transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: Math.max(2, Math.round(size * 0.14)),
        boxSizing: 'border-box',
      }}
    >
      {status === 'needs_user' ? (
        <AgentNeedsUserGlyph size={Math.max(8, size)} />
      ) : (
        <span
          className={AVATAR_STATUS_DOT_CLASS}
          style={{ width: '100%', height: '100%', borderRadius: 'var(--radius-circle)', background: color }}
        >
          {running && (
            <>
              <span className={AVATAR_STATUS_PULSE_CLASS} style={{ borderColor: color }} />
              <span className={AVATAR_STATUS_PULSE_DELAY_CLASS} style={{ borderColor: color }} />
            </>
          )}
        </span>
      )}
    </div>
  )
}

/**
 * 静止的那只小鸟:长相与会动的那只同一套读法(useAgentLook:身份缓存里存的 > 手里的头像 > 按 id 推),
 * 画成那个颜色的定格图。不剪成圆、透明底,和会动的那只一样是自由轮廓。
 */
function StillAgentBird({ id, avatar, look, name, px }: {
  id: string
  avatar: string | null
  look: AgentLook | null
  name: string
  px: number
}) {
  const resolved = useAgentLook(id, look, avatar)
  const poster = useAgentLookPoster(resolved, id)
  return (
    <img
      src={poster}
      alt={name}
      aria-label={name}
      draggable={false}
      data-agent-avatar-still={colorSlug(resolved.color)}
      width={px}
      height={px}
      className="block shrink-0 object-contain"
    />
  )
}

export function Avatar({
  name,
  avatarUrl,
  seed,
  size = 'md',
  isAgent = false,
  agentStatus,
  statusLabel,
  harnessBadge = true,
  hoverPoke = false,
  still = false,
  variant = 'default',
  imageMatteColor,
  memberAvatars,
}: AvatarProps) {
  const [imgFailed, setImgFailed] = useState(false)
  // @@@1482 规范化：字符串 "undefined"/"null"/空 视作无头像；不渲染破图。
  const normalized = normalizeAvatarUrl(avatarUrl)
  // @@@agent-look 形象地址(agentAvatar/look.ts:颜色 + 休息表情)不是一张要去加载的图 —— agent 画会动的小鸟、
  // 按它说的颜色与表情;真人的头像位上万一出现形象地址,画那个颜色的定格(人的头像不会变成会动的小鸟)。
  const look = parseAgentLook(normalized)
  const url = look ? (isAgent ? null : agentLookPoster(look, (seed ?? '').trim())) : normalized
  // @@@1482 url 变化时在 render 期重置加载失败态（React 官方「按 prop 变化调整 state」模式，非 useEffect）：
  // useEffect 在 render 之后才跑，下方 DEV throw 守卫会在同一帧用旧 imgFailed 对新有效 url 误抛。
  // render 期重置确保新 url 进来即 imgFailed=false，throw 守卫不会对有效新头像误触。
  const [trackedUrl, setTrackedUrl] = useState(url)
  if (url !== trackedUrl) {
    setTrackedUrl(url)
    setImgFailed(false)
  }
  const px = typeof size === 'number' ? size : SIZE_MAP[size]
  // 头像形状（设计稿）：真人/agent = 全圆（.av 默认 --r-pill）；群组 = 圆角方
  // （设计稿 .av.gp{border-radius:10px} / .av.lg.gp{border-radius:20px}）。
  const radius = variant === 'group' ? `${px >= 56 ? 20 : 10}px` : '50%'

  // Missing/null and failed canonical URLs stay local explicit empty states; onError records the diagnostic.
  useEffect(() => {
    reportInvalidAvatarUrl(avatarUrl, `main avatar "${name || 'unknown'}"`)
  }, [avatarUrl, name])

  const badgeSize = Math.max(8, Math.min(16, Math.round(px * 0.3)))

  const base: React.CSSProperties = {
    position: 'relative',
    width: px,
    height: px,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  }

  const imgStyle: React.CSSProperties = {
    width: px,
    height: px,
    borderRadius: radius,
    objectFit: 'cover',
    flexShrink: 0,
    display: 'block',
  }

  const matteStyle: React.CSSProperties = {
    width: px,
    height: px,
    borderRadius: radius,
    background: imageMatteColor,
    flexShrink: 0,
    display: 'inline-flex',
    overflow: 'hidden',
  }

  const emptyStyle: React.CSSProperties = {
    width: px,
    height: px,
    borderRadius: radius,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-subtle)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    userSelect: 'none',
  }

  const hasCustomAvatar = normalized != null
  const hasInvalidExplicit = avatarUrl != null && normalized == null
  const showImg = !!url && !imgFailed
  // 自定义头像坏掉（加载失败 / 非法串）才是错误；没设置头像不是错误。
  const avatarError = imgFailed || hasInvalidExplicit
  const memberCount = memberAvatars?.length ?? 0
  // A member composite represents an unset group avatar, never a replacement for an explicit failed identity.
  const showComposite = variant === 'group' && !hasCustomAvatar && !hasInvalidExplicit && memberCount > 0
  // @@@2470 没有自定义头像 → 按稳定 seed 生成默认脸。群不适用（群不是一张人脸，它要么有显式群头像、
  // 要么用成员组合表达）；自定义头像坏掉时也不生成——那要留明确错误态，不能用另一张脸盖掉。
  // @@@2470-r2 身份 key 只能是稳定 id。姓名**永远不得**当 seed：那会让同一身份在不同 surface
  // 两张脸、改名变脸、同名撞脸（复审 F2 在 4 个 surface 实锤）。没有 key 就不造脸，进可诊断空态。
  const identityKey = (seed ?? '').trim()
  const wantsGeneratedFace = !showImg && !avatarError && variant !== 'group'
  // @@@animated-agent-avatar: agent 没上传头像 → 默认脸是咕咕小鸟(会动,状态靠身体变形说,不挂角标);真人与群仍是
  // 上面那张生成脸。上传了图的 agent 仍是那张图 —— 图说不出状态,所以它继续带右上角状态角标。
  const agentBird = isAgent && wantsGeneratedFace && (identityKey !== '' || look != null)
  const animatedAgent = agentBird && !still
  const generatedUrl = wantsGeneratedFace && !agentBird && identityKey ? dicebearAvatarDataUri(identityKey) : null
  const missingIdentityKey = wantsGeneratedFace && !identityKey && !look
  useEffect(() => {
    if (!missingIdentityKey) return
    console.error(`[Avatar] missing identity key for "${name}" — a generated default face needs a stable id; display name must never seed it`)
  }, [missingIdentityKey, name])

  // 成员组合直接落在所在表面上,格间留透明空隙,不再垫一块白底。
  const compositeGap = Math.max(1, Math.round(px * 0.06))
  const compositeOuter: React.CSSProperties = {
    width: px,
    height: px,
    borderRadius: radius,
    background: 'transparent',
    boxSizing: 'border-box',
    position: 'relative',
    overflow: 'hidden',
    flexShrink: 0,
  }


  const tileRadius = size === 'sm' ? 0.05 : 0.08

  // 脸(上传图 / 组合 / 默认脸 / 空态)一律不挂原生 title:头像常被放进别人的悬停浮层(账号 Hint、
  // 运行中 agent 的预览卡),名字由外层自己说,挂了就是两个浮层叠在一起。读屏的名字在 alt / aria-label。
  return (
    <div style={base} data-agent={isAgent ? '' : undefined}>
      {showImg ? (
        imageMatteColor ? (
          <span data-avatar-matte style={matteStyle}>
            <img
              src={url!}
              alt={name}
              style={imgStyle}
              onError={() => { console.error(`[Avatar] failed to load canonical avatar for "${name || 'unknown'}"`); setImgFailed(true) }}
            />
          </span>
        ) : (
          <img
            src={url!}
            alt={name}
            style={imgStyle}
            onError={() => { console.error(`[Avatar] failed to load canonical avatar for "${name || 'unknown'}"`); setImgFailed(true) }}
          />
        )
      ) : showComposite ? (
        <div style={compositeOuter} aria-label={name}>
          {compositeLayout(memberCount).map((rect, idx) => (
            <CompositeTile
              key={memberAvatars![idx].id}
              rect={rect}
              member={memberAvatars![idx]}
              canvasPx={px}
              gapPx={compositeGap}
              radius={tileRadius}
            />
          ))}
        </div>
      ) : animatedAgent ? (
        <AgentAvatar
          id={identityKey}
          avatar={normalized}
          look={identityKey ? null : look}
          name={name}
          size={px}
          hoverPoke={hoverPoke}
          state={statusLabel ?? (agentStatus ? labelOfDisplayStatus(agentStatus) : null)}
        />
      ) : agentBird ? (
        <StillAgentBird id={identityKey} avatar={normalized} look={identityKey ? null : look} name={name} px={px} />
      ) : generatedUrl ? (
        // @@@2470 生成默认脸（#961 Notionists，CC0/本地生成/离线）：这个身份还没设置头像。
        // 它诚实表达「系统派生」而非冒充某人挑过的作品，且组合空间足够大 → 不同身份不撞脸。
        <img
          src={generatedUrl}
          alt={name}
          aria-label={name}
          draggable={false}
          style={imgStyle}
        />
      ) : (
        <span
          data-avatar-empty
          data-avatar-error={avatarError ? '' : undefined}
          aria-label={`${name || 'Avatar'} unavailable`}
          style={emptyStyle}
        />
      )}
      {isAgent && harnessBadge && variant !== 'group' ? <AgentHarnessBadge agentId={seed} avatarSize={px} /> : null}
      {agentStatus && !animatedAgent ? (
        <AgentStatusBadge status={agentStatus} size={badgeSize} />
      ) : null}
    </div>
  )
}
