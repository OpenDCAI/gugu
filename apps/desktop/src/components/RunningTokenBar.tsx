// @@@1696 统一运行态运行条：单聊/群聊共用同一「运行 token」= [头像]{名}{流光状态词}。
// DM = 1 个 token（退化态）；群聊 = 多 token 单行，排不下 → +N（hover 展开卡，去术语）。
// 消除 DM 三跳点 vs GroupAgentStatusBar(群聊竖排文字+工具名) 双轨(两者都已删)。
// 设计 SSOT: design/agent-running-group-1687.html（.bar/.tok/.state/.pop/.more/.ov/.otok/.opop）。
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MouseEvent, ReactNode } from 'react'
import { Avatar } from './Avatar'
import { useLongPress } from '../hooks/useLongPress'
import { useMobileShell } from '../hooks/useMobileShell'
import { resolveAgentRunningDisplayName } from '../lib/agentRunningStatusModels'
import type { AgentRunningStateKey } from '../lib/agentRunningVerb'
import { Popover } from './ui/Popover'
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
  /** 单行最多显示几个 token，其余进 +N；DM 传 1，群聊传 GROUP_AGENT_BAR_MAX。 */
  cap: number
  onTokenClick?: (id: string) => void
  /** 兼容既有 e2e/testid：DM 传 'agent-running-status'，群聊传 'group-agent-running-status'。 */
  testId?: string
  /** 悬停 token 弹出的 MessagePreview 读哪个 chat（#6357）；null = 不弹。 */
  previewChatId: string | null
}

// 自包含样式（:hover 卡 + 流光 + 展开卡入场需 CSS，注入一次；同时只有一个运行条实例=DM 或群聊，不重复）。
const STYLE = `
.rtb-bar{display:flex;align-items:center;gap:16px;padding:4px 14px 2px 24px;font-size:var(--font-caption);color:var(--faint-fg);white-space:nowrap;flex-shrink:0}
.rtb-tok{display:inline-flex;align-items:center;gap:7px;flex-shrink:0;border:0;padding:0;background:transparent;color:inherit;font:inherit;white-space:nowrap;cursor:default}
.rtb-tok[data-clickable=true]{cursor:pointer}
.rtb-tok:focus-visible,.rtb-more:focus-visible,.rtb-otok:focus-visible{outline:none}
.rtb-nm{color:var(--faint-fg)}
.rtb-state{background:linear-gradient(100deg,var(--faint-fg) 36%,var(--text-primary) 50%,var(--faint-fg) 64%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:running-shimmer 2s linear infinite;font-weight:500}
/* @@@float-one-edge (Refs #6104) — 浮条去掉 1px 描边:浮层只留 lift 那一层。 */
.rtb-mp{outline:none}
.rtb-more{color:var(--text-tertiary);flex-shrink:0;border:0;padding:2px 3px;background:transparent;font:inherit;cursor:pointer}
.rtb-ov{pointer-events:auto;white-space:nowrap;display:flex;align-items:center;gap:16px;background:var(--bg-elevated);border-radius:var(--radius-xl);box-shadow:var(--shadow-lift);padding:8px 12px}
.rtb-otok{display:inline-flex;align-items:center;gap:6px;flex-shrink:0;border:0;padding:0;background:transparent;color:inherit;font:inherit;white-space:nowrap;cursor:default}
.rtb-otok[data-clickable=true]{cursor:pointer}
.rtb-otok .rtb-v{color:var(--text-secondary)}
.rtb-tok,.rtb-otok{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
`

// @@@6357 悬停 token = MessagePreview。卡里是可读内容,用 Popover(与 +N 同一套悬停开合),点 token 仍是 @ 它。
function TokenPreview({
  token,
  displayName,
  chatId,
  align,
  className,
  ariaLabel,
  onTokenClick,
  children,
}: {
  token: RunningToken
  displayName: string
  chatId: string | null
  align: 'start' | 'center'
  className: string
  ariaLabel: string
  onTokenClick?: (id: string) => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const later = (next: boolean, ms: number) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(next && chatId !== null), ms)
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  // 手机没有悬停:短按 = @ 它(同桌面单击),长按 = 看详情,松手卡片留着、点别处收起。
  // ❌ 用触摸顺带的 mouseenter / focus 开卡 —— 那样短按也弹卡。
  const mobile = useMobileShell()
  const longPress = useLongPress(() => setOpen(chatId !== null))
  const pressHandlers = mobile
    ? { ...longPress, onContextMenu: (event: MouseEvent) => event.preventDefault() }
    : {
        onMouseEnter: () => later(true, 300),
        onMouseLeave: () => later(false, 150),
        onFocus: () => later(true, 300),
        onBlur: () => later(false, 150),
      }
  return (
    <Popover.Root open={open} modal={false} onOpenChange={(next) => { if (!next) later(false, 0) }}>
      <Popover.Trigger
        className={className}
        data-clickable={onTokenClick ? 'true' : 'false'}
        data-message-preview-trigger={token.id}
        aria-label={ariaLabel}
        {...pressHandlers}
        onClick={() => onTokenClick?.(token.id)}
      >
        {children}
      </Popover.Trigger>
      {chatId ? (
        <Popover.Portal>
          <Popover.Positioner side="top" align={align} sideOffset={8} collisionPadding={8}>
            {/* 开合跟着 token 自己的焦点走:卡片是只读预览,开和关都❌ 动焦点 —— 打开时焦点被挪进卡里,token blur 就关、
                关时焦点还回 token 又开,手机上一点就一开一关地闪个不停。关的那一半是 finalFocus:Base UI 关弹层时,
                焦点若在 body(悬停开的卡,焦点从没进过 token)就还给 token,token 一 focus 又开 ——
                桌面上鼠标挪开,卡片收起 300ms 后自己又弹出来(owner 2026-10-06)。 */}
            <Popover.Popup className="rtb-mp" initialFocus={false} finalFocus={false} onMouseEnter={() => later(true, 0)} onMouseLeave={() => later(false, 150)}>
              <MessagePreviewCard chatId={chatId} token={token} displayName={displayName} open={open} />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      ) : null}
    </Popover.Root>
  )
}

function RunningTokenItem({
  token,
  index,
  onTokenClick,
  previewChatId,
}: {
  token: RunningToken
  index: number
  onTokenClick?: (id: string) => void
  previewChatId: string | null
}) {
  const { t } = useTranslation('agents')
  const displayName = resolveAgentRunningDisplayName(token.name)
  const stateWord = t(`runtime.stateWord.${token.stateKey}`)
  return (
    <TokenPreview
      token={token}
      displayName={displayName}
      chatId={previewChatId}
      align="start"
      className="rtb-tok"
      ariaLabel={t('runtime.viewDetails', { name: displayName, status: stateWord })}
      onTokenClick={onTokenClick}
    >
      <Avatar name={displayName} avatarUrl={token.avatarUrl} seed={token.avatarSeed} size="xs" isAgent statusLabel="running" />
      <span className="rtb-nm">{displayName}</span>
      {/* 多 token 错开流光相位（设计稿 nth-child .5s/1s）——用 index * 0.5s 通用化。 */}
      <span className="rtb-state" style={{ animationDelay: `${index * 0.5}s` }}>
        {stateWord}
      </span>
    </TokenPreview>
  )
}

// 展开卡内被省略的 agent：静态词（.rtb-v，非流光），悬停同样是 MessagePreview。
function OverflowToken({
  token,
  onTokenClick,
  previewChatId,
}: {
  token: RunningToken
  onTokenClick?: (id: string) => void
  previewChatId: string | null
}) {
  const { t } = useTranslation('agents')
  const displayName = resolveAgentRunningDisplayName(token.name)
  const stateWord = t(`runtime.stateWord.${token.stateKey}`)
  return (
    <TokenPreview
      token={token}
      displayName={displayName}
      chatId={previewChatId}
      align="center"
      className="rtb-otok"
      ariaLabel={t('runtime.viewDetails', { name: displayName, status: stateWord })}
      onTokenClick={onTokenClick}
    >
      <Avatar name={displayName} avatarUrl={token.avatarUrl} seed={token.avatarSeed} size={16} isAgent statusLabel="running" />
      <span className="rtb-nm">{displayName}</span>
      <span className="rtb-v">{stateWord}</span>
    </TokenPreview>
  )
}

// +N 溢出：Base UI Popover 负责 click/键盘/Escape/点外关闭；hover-intent 仍保留桌面效率。
function MoreOverflow({
  tokens,
  onTokenClick,
  previewChatId,
}: {
  tokens: RunningToken[]
  onTokenClick?: (id: string) => void
  previewChatId: string | null
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
        +{tokens.length}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={8} collisionPadding={8}>
          <Popover.Popup
            className="rtb-ov"
            role="dialog"
            aria-label={t('runtime.more')}
            onMouseEnter={openNow}
            onMouseLeave={closeSoon}
          >
            {tokens.map((token) => (
              <OverflowToken key={token.id} token={token} onTokenClick={onTokenClick} previewChatId={previewChatId} />
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

export function RunningTokenBar({ tokens, cap, onTokenClick, testId, previewChatId }: RunningTokenBarProps) {
  if (tokens.length === 0) return null
  const shown = tokens.slice(0, cap)
  const overflow = tokens.slice(cap)
  return (
    <div data-testid={testId} style={{ flexShrink: 0 }}>
      <style>{STYLE}</style>
      <div className="rtb-bar">
        {shown.map((t, i) => (
          <RunningTokenItem key={t.id} token={t} index={i} onTokenClick={onTokenClick} previewChatId={previewChatId} />
        ))}
        {overflow.length > 0 && <MoreOverflow tokens={overflow} onTokenClick={onTokenClick} previewChatId={previewChatId} />}
      </div>
    </div>
  )
}
