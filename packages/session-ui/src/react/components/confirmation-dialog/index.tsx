/**
 * ConfirmationDialog
 *
 * A controlled convenience dialog for confirm/cancel decisions, composed from
 * the Dialog primitive. Renders a title, an optional description/body, and a
 * Cancel + Confirm footer.
 *
 * Closing behavior:
 *  - Cancel always closes (after invoking `onCancel`).
 *  - Confirm awaits `onConfirm`; it closes on success and stays open if the
 *    handler throws/rejects, so the caller can surface an error. Pair with
 *    `isConfirming` to disable the actions while an async handler runs.
 */

import * as React from 'react';
import { Button } from '@session-ui/react/primitives/button';
import { Dialog, type DialogSize } from '@session-ui/react/primitives/dialog';
import * as styles from './confirmation-dialog.css';
import { useMessages } from '../../localization/message-provider';

export interface ConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  /** Optional body text. Strings are wrapped in a muted paragraph. */
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Tone of the confirm button. Defaults to 'neutral'. */
  tone?: 'neutral' | 'destructive';
  /** Disables both actions while an async confirm handler is in flight. */
  isConfirming?: boolean;
  /** Dialog size. Defaults to 'xs'. */
  size?: DialogSize;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
  /** Optional extra content rendered in the body below the description. */
  children?: React.ReactNode;
}

export function ConfirmationDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = 'neutral',
  isConfirming = false,
  size = 'xs',
  onConfirm,
  onCancel,
  children,
}: ConfirmationDialogProps) {
  const { translate } = useMessages();
  const handleCancel = () => {
    onCancel?.();
    onOpenChange(false);
  };

  const handleConfirm = async () => {
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // Leave the dialog open so the caller can surface the failure.
    }
  };

  const hasBody = description != null || children != null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size={size}>
        <Dialog.Header showCloseButton={false}>
          <Dialog.Title>{title}</Dialog.Title>
        </Dialog.Header>
        {hasBody && (
          <Dialog.Body>
            {typeof description === 'string' ? (
              <p className={styles.description}>{description}</p>
            ) : (
              description
            )}
            {children}
          </Dialog.Body>
        )}
        {/* 这两枚按钮的文案是调用方给的、还随界面语言变,所以测试只能按**位置**或**文案**找它们 ——
            前者随布局一动就错位,后者随界面语言一换就失配。
            一个稳定的名字就把两种脆弱都免掉了:这个框是全产品共用的确认出口,给它一个名字比让每个
            调用方各自想办法便宜得多。 */}
        <Dialog.Footer>
          <Button
            data-testid="confirmation-dialog-cancel"
            variant="ghost"
            onClick={handleCancel}
            disabled={isConfirming}
          >
            {cancelLabel ?? translate('common.cancel')}
          </Button>
          <Button
            data-testid="confirmation-dialog-confirm"
            variant="primary"
            tone={tone}
            onClick={handleConfirm}
            disabled={isConfirming}
          >
            {confirmLabel ?? translate('common.confirm')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
