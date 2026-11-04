import { COLOR_MUTED } from './chatPresentation'

/** The same quiet transport indicator for IM and native messages awaiting acknowledgement. */
export function MessageSendingIndicator({ label, state = 'sending', title }: { label: string; state?: 'sending' | 'queued'; title?: string }) {
  return <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="gg-ring-march" role="img" aria-label={label} data-send-state={state}
    style={{ flexShrink: 0, display: 'block', opacity: 0.56 }}>
    {title ? <title>{title}</title> : null}
    <circle cx="7.5" cy="7.5" r="5.5" stroke={COLOR_MUTED} strokeWidth="1.5" strokeDasharray="2.6 3.2" strokeLinecap="round" />
  </svg>
}
