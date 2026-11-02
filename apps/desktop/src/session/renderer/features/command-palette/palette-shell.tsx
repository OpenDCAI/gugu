import type { ReactNode } from 'react'
import { Shortcut } from '@renderer/lib/ui/shortcut'
import { useSessionMessages } from '@renderer/localization/use-session-messages'

export const PALETTE_INPUT_CLASS = 'h-full min-w-24 flex-1 bg-transparent text-[length:var(--font-title)] outline-none placeholder:text-foreground/35'
export const PALETTE_HEADING_CLASS = 'flex items-center gap-2 px-3 pb-1 pt-3 text-xs text-foreground/50'
export const PALETTE_GROUP_CLASS = '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-foreground/50'

export function PaletteInputRow({ icon, children, status }: { icon: ReactNode; children: ReactNode; status?: ReactNode }) {
  return <div className="shrink-0 border-b border-foreground/[0.08]">
    <div className="flex h-12 items-center gap-2 px-4">
      <span className="flex shrink-0 text-foreground/40 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>{children}
    </div>{status}
  </div>
}

export function PaletteFooter({ completion = false, children }: { completion?: boolean; children: ReactNode }) {
  const { translate } = useSessionMessages()
  return <div className="flex shrink-0 items-center gap-4 border-t border-foreground/[0.08] px-4 py-2 text-xs text-foreground/40 max-sm:hidden">
    <span className="flex items-center gap-1"><Shortcut hotkey="ArrowUp" variant="keycaps" /><Shortcut hotkey="ArrowDown" variant="keycaps" />{translate('globalSearch.hintSelect')}</span>
    <span className="flex items-center gap-1"><Shortcut hotkey="Enter" variant="keycaps" />{translate('globalSearch.hintOpen')}</span>
    {completion && <span className="flex items-center gap-1"><Shortcut hotkey="Tab" variant="keycaps" />{translate('globalSearch.hintComplete')}</span>}
    <span className="ml-auto flex items-center gap-1">{children}</span>
  </div>
}
