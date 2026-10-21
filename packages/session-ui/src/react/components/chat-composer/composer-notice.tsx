/**
 * 通知条（`data-slot="composer-notice"`）与它的唯一生产者 `stopReasonNotice`。
 *
 * 从 `index.tsx` 拆出来（#4981 A1，理由见 `composer-options.ts` 顶部）。
 * 这两件放一起是因为它们是一条链的两端：ACP 的停止原因进来、一条通知条出去；
 * 分开放会让「哪些 reason 有 UI」这个问题要翻两个文件。
 */
import { cx } from '@session-ui/styles/utilities/cx';
import { CircleAlert, X } from '../../../icons';
import { useMessages } from '../../localization/message-provider';
import * as styles from './chat-composer.css';
import type { ComposerNotice } from './composer-options';

/**
 * Map an ACP stop reason to a composer notice. Returns null for reasons that
 * are not user-facing errors (end_turn, cancelled, unknown). Accepts a plain
 * string so callers can forward the ACP StopReason without this package
 * importing the ACP SDK.
 */
export function stopReasonNotice(reason: string): ComposerNotice | null {
  switch (reason) {
    case 'max_turn_requests':
      return {
        variant: 'error',
        title: 'Turn limit reached',
        message:
          'The agent hit the maximum number of turn requests. Send a new message to continue.',
      };
    case 'max_tokens':
      return {
        variant: 'error',
        title: 'Response truncated',
        message: 'The response was cut off after reaching the maximum token limit.',
      };
    case 'refusal':
      return {
        variant: 'error',
        title: 'Request refused',
        message: 'The agent declined to continue with this request.',
      };
    default:
      return null;
  }
}

export function NoticeBand({ notice }: { notice: ComposerNotice }) {
  const { translate } = useMessages();
  return (
    <div data-slot="composer-notice" className={styles.noticeBand({ variant: notice.variant })}>
      <div className={styles.noticeBandBody}>
        <div className={styles.noticeBandHeader}>
          <CircleAlert style={{ width: '0.875rem', height: '0.875rem', flexShrink: 0 }} />
          {notice.title && <p className={styles.noticeBandTitle}>{notice.title}</p>}
        </div>
        <p
          className={cx(styles.noticeBandMessage, notice.title && styles.noticeBandMessageIndented)}
        >
          {notice.message}
        </p>
      </div>
      {notice.onDismiss && (
        <button
          type="button"
          aria-label={translate('composer.dismissNotice')}
          onClick={notice.onDismiss}
          className={styles.noticeDismiss}
        >
          <X style={{ width: '0.875rem', height: '0.875rem' }} />
        </button>
      )}
    </div>
  );
}
