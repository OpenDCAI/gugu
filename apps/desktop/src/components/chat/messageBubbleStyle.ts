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
  compactMobile: boolean,
  joinedPrev = false,
): CSSProperties {
  // 照 Telegram:离头像远的一侧两角都是大圆角;靠头像一侧,上角在挨着同组上一条时收小,下角总是小的 ——
  // 组里中间几条挨着下一条,组尾那条由尾巴(messageBubbleChrome.css 的 [data-bubble-tail])盖住这个角。
  const big = 'var(--radius-bubble)', joined = 'var(--radius-bubble-joined)'
  const top = joinedPrev ? joined : big
  const borderRadius = isMine ? `${big} ${top} ${joined} ${big}` : `${top} ${big} ${big} ${joined}`
  return {
    position: 'relative', // 右下角的时间(BubbleTime inline)钉在气泡自己身上
    width: 'fit-content',
    maxWidth: '100cqw',
    minWidth: '44px',
    // 手机 8×16(v7.12「间距只用 4/8/16/24」,owner 10-26);桌面不动。
    padding: compactMobile ? '8px 16px' : '8px 12px',
    // #7333 IM 人聊 / IM agent 的气泡正文是「消息与长段正文」那一档(16/24,用户裁决),不是紧凑界面的 14/20。
    // 桌面与手机同一档(≥ #1787 的移动 14 下限)。
    fontSize: 'var(--font-prose)',
    lineHeight: 'var(--lh-prose)',
    wordBreak: 'break-word',
    overflowWrap: 'break-word',
    whiteSpace: 'pre-wrap',
    // Metadata and attachments keep the message menu. The mobile body root explicitly opts into selection.
    ...(compactMobile
      ? { userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }
      : {}),
    // @@@bubble-style - 无边框的纯灰填充;own 深一档 / other 浅一档(#7333 起都是纯灰)。圆角见上。
    background: isMine ? 'var(--bubble-mine)' : 'var(--bubble-other)',
    borderRadius,
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
