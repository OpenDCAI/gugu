import type { CSSProperties } from 'react'

// @@@bubble-style 消息气泡的视觉样式构造,从 MessageBubble 抽出(纯函数:只依赖 自己/悄悄话/移动端 三布尔)。
// 抽出动机:MessageBubble 是 CI 冻结的 god file(ci.yml 行数不许增长),#2242 的容器约束修复要往里加代码,
// 顺手把这段自足的样式搬出来给它让出行数——同时让「气泡长啥样」和「气泡怎么排版/约束」各自成块、更好读。
// maxWidth:100cqw 是 #2242 的关键:配合 message-bubble-column 的 container-type:inline-size,给 fit-content
// 气泡一个**确定长度**的封顶(百分比 max-width 在 shrink-to-fit 链里会被内在尺寸计算忽略),超宽块公式因此
// 在气泡内横滚而非撑破越出。
export function buildBubbleStyle(
  isMine: boolean,
  isWhisper: boolean,
  compactMobile: boolean
): CSSProperties {
  return {
    width: 'fit-content',
    maxWidth: '100cqw',
    minWidth: '44px',
    padding: '8px 12px',
    // #7333 IM 人聊 / IM agent 的气泡正文是「消息与长段正文」那一档(16/24,用户裁决),不是紧凑界面的 14/20。
    // 桌面与手机同一档(≥ #1787 的移动 14 下限)。
    fontSize: 'var(--font-prose)',
    lineHeight: 'var(--lh-prose)',
    wordBreak: 'break-word',
    overflowWrap: 'break-word',
    whiteSpace: 'pre-wrap',
    // @@@mobile-select-guard (#1227) — 触屏禁原生文本选中 + iOS callout：long-press 已是消息菜单入口
    //   (startTouchLongPress → openMenuAt)，不抑制的话原生选中/选择手柄/callout 会与菜单打架。
    //   移动端 select-none。复制走菜单 handleCopyText，桌面仍可选中文本复制。
    ...(compactMobile
      ? { userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }
      : {}),
    // @@@bubble-style - 无边框的纯灰填充 + --radius-bubble(#7333:20)圆角、靠头像侧单角收 5px。
    // own 深一档 / other 浅一档(#7333 起都是纯灰),去边框。
    ...(isMine
      ? { background: 'var(--bubble-mine)', borderRadius: 'var(--radius-bubble-sent)' }
      : { background: 'var(--bubble-other)', borderRadius: 'var(--radius-bubble-received)' }),
    // @@@whisper (#820) — whisper 气泡: 背景 var(--muted) + 文字 var(--muted-fg)（SSOT `.whisper .bub` L134）。
    // @@@933-mopup 补 color:--muted-fg(SSOT 有、原缺)。虚线边框/opacity 是 gugu 自加(SSOT 无,见 PR flag),本轮暂留。
    ...(isWhisper
      ? {
          background: 'var(--muted)',
          color: 'var(--muted-fg)',
          border: '1px dashed var(--border-subtle)',
          opacity: 0.92,
        }
      : {}),
  }
}
