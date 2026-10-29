import { ComposerAttachmentChip, type ComposerAttachmentChipProps } from './composer-attachment-chip';
import type { ComposerAttachment } from './composer-options';
import * as styles from './chat-composer.css';
import * as stripStyles from './composer-attachment-strip.css';

type Props = Pick<ComposerAttachmentChipProps, 'onView' | 'onRemove' | 'onRetry'> & {
  attachments: ComposerAttachment[];
  status?: string;
};

/** Routine waiting belongs with the files being prepared, inside the composer. */
export function ComposerAttachmentStrip({ attachments, status, ...actions }: Props) {
  if (attachments.length === 0) return null;
  return <div data-slot="composer-attachments" className={styles.attachmentStrip}>
    {attachments.map(attachment => <ComposerAttachmentChip key={attachment.id} attachment={attachment} {...actions} />)}
    {status && <span data-slot="composer-attachment-status" role="status" className={stripStyles.status}>{status}</span>}
  </div>;
}
