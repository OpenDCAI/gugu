import { useMessages } from '../../localization/message-provider';
import { ComposerAttachmentChip, type ComposerAttachmentChipProps } from './composer-attachment-chip';
import type { ComposerAttachment } from './composer-options';
import * as styles from './chat-composer.css';
import * as stripStyles from './composer-attachment-strip.css';

type Props = Pick<ComposerAttachmentChipProps, 'onView' | 'onRemove' | 'onRetry' | 'onQualityChange' | 'qualityLocked'> & {
  attachments: ComposerAttachment[];
  status?: string;
};

/** Routine waiting belongs with the files being prepared, inside the composer. */
export function ComposerAttachmentStrip({ attachments, status, ...actions }: Props) {
  const { translate } = useMessages();
  if (attachments.length === 0) return null;
  return <div data-slot="composer-attachments" className={styles.attachmentStrip}>
    {attachments.map(attachment => <ComposerAttachmentChip key={attachment.id} attachment={attachment} {...actions} />)}
    {attachments.filter(attachment => attachment.state === 'error').map(attachment =>
      <div key={`error-${attachment.id}`} data-slot="composer-attachment-error" role="status" className={stripStyles.mobileError}>
        <span>{attachment.name}: {attachment.meta}</span>
        {attachment.retryable && actions.onRetry && <button type="button" className={styles.attachmentRetry}
          aria-label={`${translate('composer.retryAttachment')} ${attachment.name}`}
          onClick={() => actions.onRetry?.(attachment.id)}>{translate('composer.retryAttachment')}</button>}
      </div>)}
    {status && <span data-slot="composer-attachment-status" role="status" className={stripStyles.status}>{status}</span>}
  </div>;
}
