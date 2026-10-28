// @@@1696 统一运行态运行条：单聊/群聊共用同一「运行 token」= [头像]{名}{流光状态词}。
// DM = 1 个 token（退化态）；群聊 = 多 token 单行，手机横滚，桌面排不下 → +N。
// 消除 DM 三跳点 vs GroupAgentStatusBar(群聊竖排文字+工具名) 双轨(两者都已删)。
// 设计 SSOT: design/agent-running-group-1687.html（.bar/.tok/.state/.pop/.more/.ov/.otok/.opop）。
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { TextShimmer } from '@gugu/session-ui/react/text-shimmer'
import type { MouseEvent } from 'react'
import { Avatar } from './Avatar'
import { useLongPress } from '../hooks/useLongPress'
import { useMobileShell } from '../hooks/useMobileShell'
import { resolveAgentRunningDisplayName } from '../lib/agentRunningStatusModels'
import type { AgentRunningStateKey } from '../lib/agentRunningVerb'
import { Popover } from './ui/Popover'
import { Chip } from './ui/Chip'
import { MessagePreviewCard } from './MessagePreviewCard'

export interface RunningToken {
  id: string
  name: string
  avatarUrl: string | null
  avatarSeed: string
  /** Stable semantic key; visible copy is resolved here against the current locale. */
  stateKey: AgentRunningStateKey
  /** 本回合工具调用次数；DM=liveStream.toolCount，群聊=近 5 分钟 actions.length（近似）；0=不显计数行。 */
  toolCount: number
  lastActiveAt: string | null
}

export interface RunningTokenBarProps {
  tokens: RunningToken[]
  onTokenClick?: (id: string) => void
  /** 兼容既有 e2e/testid：DM 传 'agent-running-status'，群聊传 'group-agent-running-status'。 */
  testId?: string
  /** 悬停 token 弹出的 MessagePreview 读哪个 chat（#6357）；null = 不弹。 */
  previewChatId: string | null
}

// 自包含样式（:hover 卡 + 流光 + 展开卡入场需 CSS，注入一次；同时只有一个运行条实例=DM 或群聊，不重复）。
const STYLE = `
.rtb-bar{position:relative;display:flex;align-items:center;gap:8px;padding:4px 14px 2px 24px;font-size:var(--font-caption);color:var(--faint-fg);white-space:nowrap;flex-shrink:0}
.rtb-bar[data-mobile=false]{padding:var(--spacing-sm) 0}
.rtb-bar[data-mobile=true]{overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:none;scroll-snap-type:x proximity}
.rtb-bar[data-mobile=true]>.rtb-tok{scroll-snap-align:start}
.rtb-tok{display:inline-flex;align-items:center;gap:7px;flex-shrink:0;min-width:0;border:0;padding:0;background:transparent;color:inherit;font:inherit;white-space:nowrap;cursor:default}
.rtb-tok[data-clickable=true]{cursor:pointer}
.rtb-pill{height:auto;gap:7px;padding:4px 8px;max-width:168px;min-width:0;background:var(--bg-elevated);box-shadow:var(--shadow-lift);color:inherit;font-weight:inherit}
.rtb-tok:focus-visible,.rtb-more:focus-visible,.rtb-otok:focus-visible{outline:none}
.rtb-nm{color:var(--faint-fg);min-width:0;overflow:hidden;text-overflow:ellipsis}
/* Three static 220%-wide repeats cover the original 160% → -60% sweep.
   Masks move 264% of the label width; glyphs move back by the same distance. */
.rtb-state{flex-shrink:0;font-weight:500;--text-shimmer-base:var(--faint-fg);--text-shimmer-light:var(--text-primary);--text-shimmer-base-mask:linear-gradient(100deg,white 36%,transparent 50%,white 64%);--text-shimmer-light-mask:linear-gradient(100deg,transparent 36%,white 50%,transparent 64%);--text-shimmer-left:-412%;--text-shimmer-width:660%;--text-shimmer-mask-size:calc(100% / 3) 100%;--text-shimmer-ink-width:calc(100% / 6.6);--text-shimmer-ink-left:calc(412% / 6.6);--text-shimmer-sweep-end:40%;--text-shimmer-ink-end:-264%;--text-shimmer-idle-sweep:calc(192% / 6.6);--text-shimmer-idle-ink:-192%;--text-shimmer-duration:2s;--text-shimmer-easing:linear;--text-shimmer-iterations:infinite}
@media(prefers-reduced-motion:reduce){.rtb-state{background:linear-gradient(100deg,var(--faint-fg) 36%,var(--text-primary) 50%,var(--faint-fg) 64%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent}}
/* @@@float-one-edge (Refs #6104) — 浮条去掉 1px 描边:浮层只留 lift 那一层。 */
.rtb-mp{outline:none}
.rtb-more{color:var(--text-tertiary);flex-shrink:0;border:0;padding:0;background:transparent;font:inherit;cursor:pointer}
.rtb-ov{pointer-events:auto;white-space:nowrap;display:flex;align-items:center;gap:16px;background:var(--bg-elevated);border-radius:var(--radius-xl);box-shadow:var(--shadow-lift);padding:8px 12px}
.rtb-otok{display:inline-flex;align-items:center;gap:6px;flex-shrink:0;border:0;padding:0;background:transparent;color:inherit;font:inherit;white-space:nowrap;cursor:default}
.rtb-otok[data-clickable=true]{cursor:pointer}
.rtb-otok .rtb-v{color:var(--text-secondary)}
.rtb-tok,.rtb-otok{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
/* 运行条那一行不接指针(ChatBottomDock),只有 pill 和 +N 接。 */
.rtb-tok,.rtb-more{pointer-events:auto}
`

/**
 * 运行条那一行(owner 10-25:「running pill 还是在下面,但是预先留空,它的出现和消失任何情况下不改变 layout」)。
 * 在可能有 agent 跑的会话里它始终占同一个高度、完全透明:里面有没有 pill、有几个、名字多长,都不改变它的高度。
 * 单行不换行:pill 最宽 168px(.rtb-pill),名字截断;桌面按这一行的宽度算放几个,其余进 +N。
 */
const PILL_GAP_PX = 8
export function RunningBarSlot({ children }: { children: ReactNode }) {
  return <div data-running-bar-slot="" className="flex h-[42px] shrink-0 items-center"><div data-running-bar-content="" className="w-full">{children}</div></div>
}
// 桌面一行能放几个:全部放得下就全放,否则留出 +N 的位置后能放几个放几个,至少 1 个。
function fitCount(width: number, pills: number[], more: number): number {
  if (pills.reduce((sum, pill) => sum + pill + PILL_GAP_PX, -PILL_GAP_PX) <= width) return pills.length
  let used = more
  for (let i = 0; i < pills.length; i++) {
    used += pills[i] + PILL_GAP_PX
    if (used > width) return Math.max(1, i)
  }
  return pills.length
}

type PreviewControl = ReturnType<typeof Popover.createHandle<RunningToken>>

// 所有 token 共用一张 MessagePreview;溢出列表只负责展开,不拥有 preview 开合状态。
function RunningTokenItem({
  token,
  index = 0,
  overflow = false,
  folded = false,
  onTokenClick,
  preview,
}: {
  token: RunningToken
  index?: number
  overflow?: boolean
  folded?: boolean
  onTokenClick?: (id: string) => void
  preview: PreviewControl
}) {
  const { t } = useTranslation('agents')
  const displayName = resolveAgentRunningDisplayName(token.name)
  const stateWord = t(`runtime.stateWord.${token.stateKey}`)
  const triggerId = useId()
  const mobile = useMobileShell()
  const longPress = useLongPress(() => preview.open(triggerId))
  const pressHandlers = mobile
    ? { ...longPress, onContextMenu: (event: MouseEvent) => event.preventDefault() }
    : {
        onFocus: () => preview.open(triggerId),
        onBlur: () => preview.close(),
      }
  return (
    <Popover.Trigger
      id={triggerId}
      handle={preview}
      openOnHover={!mobile}
      closeDelay={150}
      payload={token}
      className={overflow ? 'rtb-otok' : 'rtb-tok'}
      style={folded ? { position: 'absolute', left: 0, top: 0, visibility: 'hidden' } : undefined}
      data-clickable={onTokenClick ? 'true' : 'false'}
      data-message-preview-trigger={token.id}
      aria-label={t('runtime.viewDetails', { name: displayName, status: stateWord })}
      {...pressHandlers}
      onClick={() => onTokenClick?.(token.id)}
    >
      <Chip appearance="filled" className="rtb-pill" data-chat-dock-obstacle="">
        <Avatar name={displayName} avatarUrl={token.avatarUrl} seed={token.avatarSeed} size={overflow ? 16 : 'xs'} isAgent statusLabel="running" />
        <span className="rtb-nm">{displayName}</span>
        {overflow ? <span className="rtb-v">{stateWord}</span> : (
          <TextShimmer className="rtb-state" style={{ animationDelay: `${index * 0.5}s` }}>{stateWord}</TextShimmer>
        )}
      </Chip>
    </Popover.Trigger>
  )
}

// +N 溢出：Base UI Popover 负责 click/键盘/Escape/点外关闭；hover-intent 仍保留桌面效率。
function MoreOverflow({
  tokens,
  onTokenClick,
  preview,
}: {
  tokens: RunningToken[]
  onTokenClick?: (id: string) => void
  preview: PreviewControl
}) {
  const { t } = useTranslation('agents')
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openNow = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const closeSoon = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), 200)
  }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])
  return (
    <Popover.Root open={open} modal={false} onOpenChange={setOpen}>
      <Popover.Trigger
        className="rtb-more"
        aria-label={t('runtime.viewMore', { count: tokens.length })}
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
      >
        <Chip appearance="filled" className="rtb-pill" data-chat-dock-obstacle="">+{tokens.length}</Chip>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={8} collisionPadding={8}>
          <Popover.Popup
            className="rtb-ov"
            initialFocus={false}
            finalFocus={false}
            role="dialog"
            aria-label={t('runtime.more')}
            onMouseEnter={openNow}
            onMouseLeave={closeSoon}
          >
            {tokens.map((token) => (
              <RunningTokenItem key={token.id} token={token} overflow onTokenClick={onTokenClick} preview={preview} />
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

export function RunningTokenBar({ tokens, onTokenClick, testId, previewChatId }: RunningTokenBarProps) {
  const [handle] = useState(() => Popover.createHandle<RunningToken>())
  const mobile = useMobileShell()
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [fitted, setFitted] = useState(Number.POSITIVE_INFINITY)
  const empty = tokens.length === 0
  const visible = mobile ? tokens.length : fitted
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el || mobile) return
    const pills = [...el.querySelectorAll<HTMLElement>('.rtb-bar > [data-message-preview-trigger]')]
    const more = el.querySelector<HTMLElement>('.rtb-more')
    const report = () => setFitted(fitCount(el.clientWidth, pills.map(pill => pill.offsetWidth), more?.offsetWidth ?? 0))
    const observer = new ResizeObserver(report)
    observer.observe(el)
    pills.forEach(pill => observer.observe(pill))
    if (more) observer.observe(more)
    report()
    return () => observer.disconnect()
  }, [tokens, mobile, visible]) // Re-measure after +N mounts or its digit count changes.
  if (empty) return null
  const overflow = tokens.slice(visible)
  return (
    <div ref={boxRef} data-testid={testId} style={{ flexShrink: 0, width: '100%', minWidth: 0 }}>
      <style>{STYLE}</style>
      <Popover.Root handle={handle} modal={false} onOpenChange={(_open, details) => {
        // 单击仍然是 @;预览只由悬停、键盘焦点或手机长按打开。
        if (details.reason === 'trigger-press') details.cancel()
      }}>
        {({ payload: token }) => <>
          <div className="rtb-bar" data-mobile={mobile}>
            {tokens.map((t, i) => (
              <RunningTokenItem key={t.id} token={t} index={i} folded={i >= visible} onTokenClick={onTokenClick} preview={handle} />
            ))}
            {overflow.length > 0 && <MoreOverflow tokens={overflow} onTokenClick={onTokenClick} preview={handle} />}
          </div>
          {previewChatId && token ? <Popover.Portal>
            <Popover.Positioner side="top" align={overflow.some((item) => item.id === token.id) ? 'center' : 'start'} sideOffset={8} collisionPadding={8}>
              {/* 只读预览不移动或归还焦点,避免 token blur/focus 导致循环开合。 */}
              <Popover.Popup className="rtb-mp" initialFocus={false} finalFocus={false}>
                <MessagePreviewCard chatId={previewChatId} token={token} displayName={resolveAgentRunningDisplayName(token.name)} open={handle.isOpen} />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal> : null}
        </>}
      </Popover.Root>
    </div>
  )
}
