import type { SessionFailure } from '@renderer/features/sessions/stores/session-failure';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { creationFailureCopy } from '../session-input-failure-copy';
import { useSessionInputNotice } from '../session-input-notice';

/** All creation surfaces report through the existing outlet; drafts remain available to resend. */
export function CreateDeliveryError({ failure, noticeKey = 'session-create' }: { failure: SessionFailure | null; noticeKey?: string }) {
  const { translate } = useSessionMessages();
  useSessionInputNotice(noticeKey, failure ? {
    title: creationFailureCopy(failure, translate), diagnostic: failure,
  } : null);
  return null;
}
