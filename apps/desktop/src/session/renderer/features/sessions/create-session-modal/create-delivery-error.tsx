import { useRef } from 'react';
import type { SessionFailure } from '@renderer/features/sessions/stores/session-failure';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { codexNeedsUpgrade, creationFailureCopy } from '../session-input-failure-copy';
import { useSessionInputNotice } from '../session-input-notice';

/** All creation surfaces report through the existing outlet; drafts remain available to resend. */
export function CreateDeliveryError({ failure, noticeKey = 'session-create' }: { failure: SessionFailure | null; noticeKey?: string }) {
  const { translate } = useSessionMessages();
  const previousKey = useRef(noticeKey);
  const key = failure
    ? failure.kind === 'raw' && codexNeedsUpgrade(failure.detail) && failure.target
      ? `session-catalog:${failure.target.machineId ?? 'local'}:codex:${failure.target.leg}`
      : noticeKey
    : previousKey.current;
  if (failure) previousKey.current = key;
  useSessionInputNotice(key, failure ? {
    title: creationFailureCopy(failure, translate), diagnostic: failure,
  } : null);
  return null;
}
