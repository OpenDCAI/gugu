import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { useUiPortalContainer } from '@session-ui/react/lib/portal-container';
import { Button } from '@session-ui/react/primitives/button';
import { ScrollContainer } from '@session-ui/react/primitives/scroll-container';
import { cx } from '@session-ui/styles/utilities/cx';
import { XIcon } from '../../../icons'
import * as React from 'react';
import type { FixedDataSlotProps } from '../fixed-data-slot';
import * as styles from './dialog.css';

export type DialogSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

// ── Root parts ────────────────────────────────────────────────────────────────

function DialogRoot({ ...props }: FixedDataSlotProps<DialogPrimitive.Root.Props>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: FixedDataSlotProps<DialogPrimitive.Trigger.Props>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: FixedDataSlotProps<DialogPrimitive.Portal.Props>) {
  const portalContainer = useUiPortalContainer();
  return (
    <DialogPrimitive.Portal
      data-slot="dialog-portal"
      container={portalContainer}
      {...props}
    />
  );
}

function DialogClose({ ...props }: FixedDataSlotProps<DialogPrimitive.Close.Props>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: FixedDataSlotProps<DialogPrimitive.Backdrop.Props>) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cx(styles.overlay, className)}
      {...props}
    />
  );
}

// ── Content shell ─────────────────────────────────────────────────────────────

function DialogContent({
  className,
  children,
  size = 'md',
  ...props
}: FixedDataSlotProps<DialogPrimitive.Popup.Props> & { size?: DialogSize }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <div className={styles.positioner}>
        <DialogPrimitive.Popup
          data-slot="dialog-content"
          className={cx('surface-base', styles.content({ size }), className)}
          {...props}
        >
          {children}
        </DialogPrimitive.Popup>
      </div>
    </DialogPortal>
  );
}

// ── Header / Body / Footer ────────────────────────────────────────────────────

function DialogHeader({
  className,
  children,
  showCloseButton = true,
  ...props
}: FixedDataSlotProps<React.ComponentProps<'div'>> & { showCloseButton?: boolean }) {
  return (
    <div data-slot="dialog-header" className={cx(styles.header, className)} {...props}>
      <div className={styles.headerInner}>{children}</div>
      {showCloseButton && (
        <DialogPrimitive.Close
          render={
            <Button
              variant="ghost"
              size="sm"
              icon
              aria-label="Close"
              className={styles.closeButtonOverride}
            />
          }
        >
          <XIcon style={{ width: '1rem', height: '1rem' }} />
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogBody({
  className,
  children,
  style,
  maxHeight,
  topFade = true,
}: {
  className?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  maxHeight?: number | string;
  topFade?: boolean;
}) {
  return (
    <ScrollContainer
      maxHeight={maxHeight}
      topFade={topFade}
      style={{ minHeight: 0, ...style }}
      viewportClassName={cx(styles.body, className)}
    >
      {children}
    </ScrollContainer>
  );
}

function DialogFooter({
  className,
  children,
  ...props
}: FixedDataSlotProps<React.ComponentProps<'div'>>) {
  return (
    <div data-slot="dialog-footer" className={cx(styles.footer, className)} {...props}>
      {children}
    </div>
  );
}

function DialogTitle({ className, ...props }: FixedDataSlotProps<DialogPrimitive.Title.Props>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cx(styles.title, className)}
      {...props}
    />
  );
}

export const Dialog = {
  Root: DialogRoot,
  Trigger: DialogTrigger,
  Portal: DialogPortal,
  Close: DialogClose,
  Overlay: DialogOverlay,
  Content: DialogContent,
  Header: DialogHeader,
  Body: DialogBody,
  Footer: DialogFooter,
  Title: DialogTitle,
};
