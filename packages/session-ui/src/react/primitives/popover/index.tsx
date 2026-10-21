'use client';

import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { useUiPortalContainer } from '@session-ui/react/lib/portal-container';
import { cx } from '@session-ui/styles/utilities/cx';
import * as React from 'react';
import type { FixedDataSlotProps } from '../fixed-data-slot';
import * as styles from './popover.css';

function PopoverRoot({ ...props }: FixedDataSlotProps<PopoverPrimitive.Root.Props>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: FixedDataSlotProps<PopoverPrimitive.Trigger.Props>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = 'center',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 4,
  anchor,
  ...props
}: FixedDataSlotProps<PopoverPrimitive.Popup.Props> &
  Pick<
    PopoverPrimitive.Positioner.Props,
    'align' | 'alignOffset' | 'side' | 'sideOffset' | 'anchor'
  >) {
  const portalContainer = useUiPortalContainer();
  return (
    <PopoverPrimitive.Portal container={portalContainer}>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        anchor={anchor}
        className={styles.positioner}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cx('surface-elevated', styles.popupContent, className)}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverHeader({ className, ...props }: FixedDataSlotProps<React.ComponentProps<'div'>>) {
  return (
    <div data-slot="popover-header" className={cx(styles.popoverHeader, className)} {...props} />
  );
}

function PopoverTitle({ className, ...props }: FixedDataSlotProps<PopoverPrimitive.Title.Props>) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cx(styles.popoverTitle, className)}
      {...props}
    />
  );
}

function PopoverDescription({
  className,
  ...props
}: FixedDataSlotProps<PopoverPrimitive.Description.Props>) {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      className={cx(styles.popoverDescription, className)}
      {...props}
    />
  );
}

function PopoverClose({ ...props }: FixedDataSlotProps<PopoverPrimitive.Close.Props>) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

export const Popover = {
  Root: PopoverRoot,
  Trigger: PopoverTrigger,
  Content: PopoverContent,
  Header: PopoverHeader,
  Title: PopoverTitle,
  Description: PopoverDescription,
  Close: PopoverClose,
};
