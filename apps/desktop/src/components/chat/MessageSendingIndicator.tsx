import { COLOR_MUTED } from './chatPresentation'

/** The same quiet transport indicator for IM and native messages awaiting acknowledgement. */
export function MessageSendingIndicator({ label, state = 'sending', title }: { label: string; state?: 'sending' | 'queued'; title?: string }) {
  return <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="gg-ring-march" role="img" aria-label={label} data-send-state={state}
    style={{ flexShrink: 0, display: 'block', opacity: 0.56 }}>
    {title ? <title>{title}</title> : null}
    <circle cx="7.5" cy="7.5" r="5.5" stroke={COLOR_MUTED} strokeWidth="1.5" strokeDasharray="2.6 3.2" strokeLinecap="round" />
  </svg>
}

export function MessageReceivingIndicator({ label }: { label: string }) {
  return <svg width="15" height="15" viewBox="0 0 15 15" role="img" aria-label={label} data-send-state="receiving"
    style={{ flexShrink: 0, display: 'block', opacity: .56 }}>
    {[3, 7.5, 12].map((x, index) => <circle key={x} cx={x} cy="7.5" r="1.3" fill={COLOR_MUTED}
      className="gg-receive-dot" style={{ animationDelay: `${index * 140}ms` }} />)}
  </svg>
}
