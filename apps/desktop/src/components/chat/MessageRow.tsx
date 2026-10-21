import type { CSSProperties, MouseEventHandler, ReactNode, Ref } from 'react'

type MessageRowProps = {
  messageId: string
  index: number
  count: number
  children: ReactNode
  rowRef?: Ref<HTMLDivElement>
  className?: string
  style?: CSSProperties
  onContextMenu?: MouseEventHandler<HTMLDivElement>
}

export function MessageRow({ messageId, index, count, children, rowRef, className, style, onContextMenu }: MessageRowProps) {
  return (
    // Contain the date divider's margins so the row's box (flow-list anchoring) covers the whole
    // row when an older page changes which message owns that divider.
    <div ref={rowRef} role="listitem" aria-posinset={index + 1} aria-setsize={count} data-msg-id={messageId} className={className ? `flow-root ${className}` : 'flow-root'} style={style} onContextMenu={onContextMenu}>
      {children}
    </div>
  )
}
