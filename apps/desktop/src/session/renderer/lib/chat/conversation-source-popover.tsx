import { useRef } from 'react';
import { Popover } from '@/components/ui/Popover';

/** The arrow alone opens the preview; touch opens it before the explicit source action navigates. */
export function ConversationSourcePopover(props: { text: string; label: string; onOpenOriginal: () => void }) {
  const touch = useRef(false);
  return <Popover.Root>
    <Popover.Trigger openOnHover delay={0} closeDelay={100} render={<button type="button" data-slot="conversation-quote"
      aria-label={props.label} className="inline-flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-inherit"
      onPointerDown={event => { touch.current = event.pointerType === 'touch'; }}
      onClick={event => { event.stopPropagation(); if (!touch.current) props.onOpenOriginal(); }}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M12.5 3v4.5a3 3 0 0 1-3 3H3m3.5-3.5L3 10.5 6.5 14" /></svg>
    </button>} />
    <Popover.Portal><Popover.Positioner side="top" sideOffset={6} collisionPadding={8}>
      <Popover.Popup className="max-w-[min(320px,calc(100vw-16px))] rounded-lg border border-[var(--border)] bg-[var(--popover)] p-2 text-xs text-[var(--text-primary)] shadow-[var(--shadow-lift)]">
        <Popover.Title className="sr-only">{props.label}</Popover.Title>
        <button type="button" data-slot="conversation-quote-preview" className="max-h-56 cursor-pointer overflow-auto whitespace-pre-wrap text-left"
          onClick={props.onOpenOriginal}>{props.text}</button>
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}
