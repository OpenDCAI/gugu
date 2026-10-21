'use client';

import { PreviewCard as PreviewCardPrimitive } from '@base-ui/react/preview-card';
import { useUiPortalContainer } from '@gugu/session-ui/react/primitives';
import { cn } from '@renderer/utils/utils';

/**
 * Hover preview (Base UI `PreviewCard`, 1.6.0): a card that opens while the
 * pointer rests on — or focus sits in — its trigger, and closes when it leaves.
 * Same popup recipe as `popover.tsx`; only the open/close rule differs (hover
 * vs click). First consumer: the session timeline's per-tick preview (#4874).
 */
function PreviewCard(props: PreviewCardPrimitive.Root.Props) {
  return <PreviewCardPrimitive.Root {...props} />;
}

function PreviewCardTrigger(props: PreviewCardPrimitive.Trigger.Props) {
  return <PreviewCardPrimitive.Trigger data-slot="preview-card-trigger" {...props} />;
}

function PreviewCardContent({
  className,
  align = 'center',
  side = 'right',
  sideOffset = 8,
  ...props
}: PreviewCardPrimitive.Popup.Props &
  Pick<PreviewCardPrimitive.Positioner.Props, 'align' | 'side' | 'sideOffset'>) {
  return (
    <PreviewCardPrimitive.Portal container={useUiPortalContainer()}>
      <PreviewCardPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <PreviewCardPrimitive.Popup
          data-slot="preview-card-content"
          className={cn(
            'z-50 flex origin-(--transform-origin) flex-col gap-1 overflow-hidden rounded-surface bg-background-quaternary p-3 text-sm text-foreground shadow-lift outline-hidden duration-[var(--dur-fast)] data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
            className
          )}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

export { PreviewCard, PreviewCardContent, PreviewCardTrigger };
