import type { ReactNode } from 'react'

/** Message-list artwork and attention share one square slot, including pending tasks. */
export function PhoneMessageAvatar({ children, badge }: { children: ReactNode; badge?: ReactNode }) {
  return <span className="gg-phone-message-avatar">
    {children}
    {badge ? <span className="gg-phone-message-avatar-badge">{badge}</span> : null}
  </span>
}
