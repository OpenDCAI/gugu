import { rendererLogger } from '@/lib/log'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
// @@@sessionpage TASKPAGE-FUSION 分享 — 会话页点「分享」后的浮层。
//
// owner 实机反馈:原先直接弹名片海报是错的形态 —— 海报是一张图,「链接没法复制,agent id 也没法复制」。
// 浮层里的东西要**能选能复制**,海报降级成其中一个次级动作。
//
// #6093 第三轮:浮层**只做分享**。从前它还兼着改 agent 名(双击名字)和一大段说明文字,字太多、一眼看不出
// 哪个是要复制的值;改名归到会话页侧栏的「重命名」弹窗(#6091)。现在的形状(assistant-ui design.md):
//  · 头:「分享 <名字>」+ 关闭。
//  · 一张**表**:左列标签、右列值,只有分享要用的两行 —— 咕咕号 / 邀请链接。agent 名、agent ID、会话 ID
//    **不在这里**:那是「这条会话是谁」,归侧栏身份卡(#6092;owner 2026-09-21:「不是放到会话悬浮上了吗」)。
//    行之间没有分隔线,靠节奏与 hover 底呼吸;两条 hairline 只画在表的上下(区段边界是页面唯一欠着的线)。
//    **整行点一下就复制**,复制图标只在 hover 时露出,复制成功就地换成 ✓ 「已复制」,❌ 飞到右上角的 toast
//    (那条车道被顶栏动作占着,飞过去就是盖住按钮)。与侧栏身份卡同一套行,一个观感。
//  ⚠️ 咕咕主体这套 Tailwind 的间距刻度是 xs/sm/md/lg(tailwind.config.cjs),❌ 数字刻度(px-md)在这里是哑类。
//  · 咕咕号用 mono(design.md:mono 只给「你会敲进去的东西」),标签用正文字。
//  · 脚:一个动作。有号 → 生成名片海报;没号 → 开启公开并分配咕咕号(咕咕号懒分配:只有开启「公开」时才铸),
//    说明文字只在没号态出现一句,有号态一个字都没有。
//
// @@@share-popover-dismiss 位置与关闭(第二轮 owner 实机反馈,病根是从前 `position: fixed; right: 16` 按
// 窗口右缘拍坐标,右侧面板一开就压在面板上):
//  · 位置:Base UI Popover 的 anchor 指向分享按钮本体(两棵 React 树,并入本体后同一个 document,
//    见 lib/sessionpageShareAnchor)。翻转/避让/跟随重排都由定位系统负责 —— ❌ 不再有第二处坐标。
//  · 关闭:点外 / Esc 由 Base UI 出,头上还有一个关闭钮 —— 与本仓其它点开的浮层同一套。
//    ❌ 鼠标移走就收(#4116 曾挂过 useHoverDismiss):点开的浮层要留给人去复制,鼠标一离开按钮就没了,
//    等于不让用(owner 2026-09-26 实机:「鼠标一旦移开它,那个 pop up 就会消失」)。移走即收只属于悬停开的卡。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, X } from '@/lib/icons'
import { Popover } from '../ui/Popover'

export interface AgentSharePopoverProps {
  name: string
  /** 未公开的 agent 还没有咕咕号(懒分配);null = 未分配。 */
  guguNumber: number | null
  agentUserId: string
  /** 扫码/打开即可加它的链接(与名片海报里那张二维码同一个 URL,单一数据源);没有咕咕号就生成不出来。 */
  inviteUrl: string | null
  /**
   * 取分享按钮本体。传**取值函数**而不是元素:会话页那棵树重渲染时按钮节点会被换掉,
   * 拿着旧节点定位就是对着一个已脱离文档的元素算坐标(rect 全 0 → 浮层飞到左上角)。
   * 取不到(会话页没渲染出入口)→ 浮层退回窗口右上角的兜底位置,那就是它从前待的地方。
   */
  anchor: () => Element | null
  onOpenPoster: () => void
  /** 开启公开(铸号)。resolve 后由宿主刷新 guguNumber / inviteUrl。 */
  onMakePublic: () => Promise<void>
  onClose: () => void
}

const COPIED_MS = 1600
// 脚上那一个动作:与本仓其它浮层里的次级按钮同一副样子(边框 + input 底)。
const actionButton: React.CSSProperties = {
  fontSize: 'var(--font-body)',
  padding: '5px 12px',
  borderRadius: 'var(--radius-control)',
  border: '1px solid var(--border-color)',
  background: 'var(--input-bg)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
}

/** 顶栏右上那条转瞬层车道的 top —— 只认 --titlebar-actions-lane 这一个数(design notes)。 */
function titlebarActionsLanePx(): number {
  if (typeof window === 'undefined') return 40
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--titlebar-actions-lane')
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : 40
}

interface ShareRow {
  key: 'guguNumber' | 'inviteLink'
  label: string
  /** 复制出去的值;null = 这一格没有(咕咕号未分配),写「未分配」且不可复制。 */
  value: string | null
  mono: boolean
}

// ⚠️ 这个浮层 portal 到 body 下、在 .gugu-skin 作用域**之外**,咕咕主体那套 Tailwind 工具类在这里一个都不生效
// (实测 pl-md 在 body 上是 0、在 .gugu-skin 里是 12px)。所以布局一律内联样式 + tokens 变量,与本仓其它
// 锚定浮层(ReadReceiptPopover 等)同一做法;❌ 别再往这里写 className 布局。
// 字号只有一个:--font-body(owner 2026-09-21:「文字大小不统一」)—— 标签、值、提示、标题都是它。
const rowBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '4px 12px',
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
  transition: 'background-color var(--transition-fast)',
}
const rowLabel: React.CSSProperties = {
  flexShrink: 0,
  width: 72,
  fontSize: 'var(--font-body)',
  lineHeight: '20px',
  color: 'var(--text-secondary)',
}
const rowValue: React.CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 'var(--font-body)',
  lineHeight: '20px',
  color: 'var(--text-primary)',
}
const rowIcon: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 16,
  height: 16,
  flexShrink: 0,
  color: 'var(--text-secondary)',
  transition: 'opacity var(--transition-fast)',
}

function ShareRowItem({ row, unassigned, copiedLabel, copyLabel }: {
  row: ShareRow
  unassigned: string
  copiedLabel: string
  copyLabel: string
}) {
  const [state, setState] = useState<string | null>(null)
  const [hovered, setHovered] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const flash = (next: string) => {
    setState(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState(null), COPIED_MS)
  }
  const copy = async () => {
    if (row.value === null) return
    try {
      await navigator.clipboard.writeText(row.value)
      flash(copiedLabel)
    } catch (error) {
      const reason = String((error as Error)?.message ?? error)
      rendererLogger('clipboard').error({ error: reason }, 'copy agent identity failed')
      flash(safeFailureLine(reason))
    }
  }
  const valueStyle: React.CSSProperties = {
    ...rowValue,
    ...(row.mono ? { fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', fontVariantLigatures: 'none' } : null),
    ...(row.value === null || state !== null ? { color: 'var(--text-secondary)' } : null),
  }

  if (row.value === null) {
    return (
      <div data-share-row={row.key} style={rowBase}>
        <span style={rowLabel}>{row.label}</span>
        <span style={valueStyle}>{unassigned}</span>
      </div>
    )
  }
  return (
    <button
      type="button"
      data-share-row={row.key}
      data-copy-state={state === null ? 'idle' : state === copiedLabel ? 'copied' : 'failed'}
      aria-label={copyLabel}
      onClick={() => void copy()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      className="gg-pressable"
      style={{ ...rowBase, cursor: 'pointer', background: hovered ? 'var(--hover)' : 'transparent' }}
    >
      <span style={rowLabel}>{row.label}</span>
      {/* 反馈**就地替换值那一格**,不另占一列:右侧只留 16px 给图标(与侧栏身份卡同一形状)。 */}
      <span aria-live="polite" style={valueStyle}>
        {state ?? row.value}
      </span>
      <span style={{ ...rowIcon, opacity: hovered || state !== null ? 1 : 0 }}>
        {state === copiedLabel ? <Check size={13} /> : <Copy size={13} />}
      </span>
    </button>
  )
}

export function AgentSharePopover({
  name,
  guguNumber,
  agentUserId,
  inviteUrl,
  anchor,
  onOpenPoster,
  onMakePublic,
  onClose,
}: AgentSharePopoverProps) {
  const { t } = useTranslation()

  // 没有按钮可锚时的兜底锚:窗口右缘 16px、顶栏车道上的一个零尺寸点。配合 side/align 画出来的位置
  // 与从前的 `right: 16` 完全一致 —— 兜底不是新形态,只是没了跟随。
  const fallbackAnchor = useMemo(
    () => ({
      // 返回普通对象而不是 DOMRect:定位系统只读这几个字段,而 DOMRect.fromRect 在 jsdom 里未必有 ——
      // 兜底路径不该是「只有真浏览器才跑得起来」的那一条。
      getBoundingClientRect: () => {
        const top = titlebarActionsLanePx()
        const right = (typeof window === 'undefined' ? 0 : window.innerWidth) - 16
        return { x: right, y: top, width: 0, height: 0, top, right, bottom: top, left: right }
      },
    }),
    [],
  )

  // 定位锚:Base UI 在挂载时解析一次这个函数,之后由 autoUpdate 跟住那个元素 —— 聊天栏被右侧面板
  // 挤窄、窗口缩放、内容重排,浮层都跟着按钮走,这正是从前 `right: 16` 做不到的那件事。
  const positionAnchor = useCallback(() => anchor() ?? fallbackAnchor, [anchor, fallbackAnchor])

  const [makingPublic, setMakingPublic] = useState(false)
  const [makePublicError, setMakePublicError] = useState<string | null>(null)
  const hasNumber = guguNumber !== null

  const handleMakePublic = async () => {
    if (makingPublic) return
    setMakingPublic(true)
    setMakePublicError(null)
    try {
      await onMakePublic()
    } catch (error) {
      setMakePublicError(error instanceof Error ? error.message : t('agentShare.makePublicFailed'))
    } finally {
      setMakingPublic(false)
    }
  }

  const rows: ShareRow[] = [
    { key: 'guguNumber', label: t('agentShare.guguNumber'), value: hasNumber ? String(guguNumber) : null, mono: true },
    // 没号就没有链接:❌ 摆一个生成不出来的邀请链接行。
    ...(hasNumber && inviteUrl
      ? [{ key: 'inviteLink' as const, label: t('agentShare.inviteLink'), value: inviteUrl, mono: false }]
      : []),
  ]

  return (
    <Popover.Root
      open
      // ❌ 不做模态:分享是随手看一眼的动作,拦住整个应用(焦点陷阱 + 背景不可点)与它的份量不符,
      // 也会让「鼠标移走就自己收」变成一件危险的事(收之前用户点不了别处)。
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={positionAnchor}
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
        >
          <Popover.Popup
            role="dialog"
            aria-label={t('agentShare.dialog', { name })}
            data-agent-user-id={agentUserId}
            style={{
              width: 320,
              maxWidth: 'calc(100vw - 32px)',
              // @@@share-popover-opaque 浮层底必须**不透明**(owner 实机:「现在透明有点影响观感」)。
              // --bg-elevated 才是这仓锚定信息浮层的底(暗 #1a1c24 / 亮 #fff,即设计稿的 --popover),
              // 与 ReadReceiptPopover、AgentRecentActionPopover 同一个 —— ❌ 别在这里另拍一个颜色。
              background: 'var(--bg-elevated)',
              // 举起来的物件:一圈 hairline + 一层 lift 影,圆角 12(design.md --radius-xl:floating card)。
              boxShadow: '0 0 0 1px var(--border-color), 0 12px 32px rgba(0,0,0,0.18)',
              borderRadius: 'var(--radius-xl)',
              overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 8px 8px 12px' }}>
              <div
                data-testid="agent-share-name"
                style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--font-body)', fontWeight: 600, color: 'var(--text-primary)' }}
              >
                {t('agentShare.dialog', { name })}
              </div>
              <button
                type="button"
                aria-label={t('agentShare.close')}
                title={t('agentShare.close')}
                onClick={onClose}
                className="gg-pressable"
                style={{ width: 24, height: 24, border: 'none', background: 'transparent', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', borderRadius: 'var(--radius-document)' }}
              >
                <X size={14} />
              </button>
            </div>

            <div style={{ borderTop: '1px solid var(--border-color)', padding: '4px 0' }}>
              {rows.map((row) => (
                <ShareRowItem
                  key={row.key}
                  row={row}
                  unassigned={t('agentShare.numberUnassigned')}
                  copiedLabel={t('agentShare.copied')}
                  copyLabel={t('agentShare.copyRow', { label: row.label })}
                />
              ))}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderTop: '1px solid var(--border-color)', padding: '8px 12px' }}>
              {/* 脚上只有一个动作:有号 → 生成海报;没号 → 开启公开(铸号)。说明文字只在没号态出现一句。 */}
              <span style={{ minWidth: 0, fontSize: 'var(--font-body)', lineHeight: 1.4, color: makePublicError ? 'var(--text-danger, #b3261e)' : 'var(--text-secondary)' }}>
                {hasNumber ? null : (makePublicError ?? t('agentShare.makePublicHint'))}
              </span>
              <button
                type="button"
                onClick={hasNumber ? onOpenPoster : () => void handleMakePublic()}
                className="gg-pressable"
                aria-disabled={(!hasNumber && makingPublic) || undefined}
                style={{ ...actionButton, flexShrink: 0, opacity: !hasNumber && makingPublic ? 0.6 : 1 }}
              >
                {hasNumber
                  ? t('agentShare.generatePoster')
                  : makingPublic
                    ? t('agentShare.makingPublic')
                    : t('agentShare.makePublic')}
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
