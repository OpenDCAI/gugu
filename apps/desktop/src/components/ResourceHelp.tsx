import type { ReactNode } from 'react'
import { Info } from '@/lib/icons'
import { useMobileShell } from '@/hooks/useMobileShell'
import { Popover } from './ui/Popover'
import './resource-help.css'

type Frame = { label: string; picture: ReactNode }
export interface ResourceHelpProps { title: string; description: string; frames: readonly [Frame, Frame, Frame, Frame] }

/** A short explanation, opened by hover or a press; reduced motion shows all frames. */
export function ResourceHelp({ title, description, frames }: ResourceHelpProps) {
  const mobile = useMobileShell()
  return <Popover.Root>
    <Popover.Trigger openOnHover={!mobile} aria-label={title} className="inline-flex size-7 items-center justify-center rounded-control text-foreground-secondary hover:bg-hover" data-testid="resource-help">
      <Info className="size-4" />
    </Popover.Trigger>
    <Popover.Portal><Popover.Positioner sideOffset={6}><Popover.Popup className="w-72 rounded-surface border border-border bg-background p-3 text-foreground shadow-lift">
      <Popover.Title className="m-0 text-sm font-medium">{title}</Popover.Title>
      <Popover.Description className="my-2 text-sm text-foreground-secondary">{description}</Popover.Description>
      <ol className="resource-help-frames">
        {frames.map((frame, index) => <li key={index}>
          <span aria-hidden="true" className="resource-help-picture">{frame.picture}</span><span>{index + 1}. {frame.label}</span>
        </li>)}
      </ol>
    </Popover.Popup></Popover.Positioner></Popover.Portal>
  </Popover.Root>
}
