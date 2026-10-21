import { Info } from '@/lib/icons';
import React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/utils/utils';

/**
 * A ⓘ beside a setting's name: the longer word about it. One look for every page that has one.
 *
 * A Popover that also opens on hover, not a tooltip — Base UI's own advice for infotips (Tooltip → Alternatives): a
 * tooltip never opens on touch, and a phone has no hover (owner 10-14). Hover, a click, a press outside, Escape and
 * focus are all Base UI's; nothing of its own here. Drawn as the tooltip was.
 */
export function InfoTooltip({
  label,
  content,
  contentClassName = 'max-w-xs',
}: {
  label: string;
  content: React.ReactNode;
  /** The words' width limit. */
  contentClassName?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        aria-label={label}
        className="text-foreground-muted inline-flex h-4 w-4 items-center justify-center transition-colors hover:text-foreground active:opacity-70"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </PopoverTrigger>
      {/* w-max: as wide as its words, up to the limit — not as wide as where it is mounted. The Settings dialog mounts
          popups in a zero-size layer (gg-session-settings-layer), where a shrink-to-fit popup wrapped every word. */}
      <PopoverContent
        side="top"
        className={cn('w-max gap-0 bg-foreground px-3 py-1 text-xs text-background shadow-none', contentClassName)}
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}
