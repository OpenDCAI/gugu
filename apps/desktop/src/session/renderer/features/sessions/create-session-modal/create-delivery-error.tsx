import { useRef } from 'react';
import type { SessionFailure } from '@renderer/features/sessions/stores/session-failure';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { codexNeedsUpgrade, creationFailureCopy } from '../session-input-failure-copy';
import { useSessionInputNotice } from '../session-input-notice';

/** All creation surfaces report through the existing outlet; drafts remain available to resend. */
export function CreateDeliveryError({ failure, noticeKey = 'session-create' }: { failure: SessionFailure | null; noticeKey?: string }) {
  const { translate } = useSessionMessages();
  const previousKey = useRef(noticeKey);
  const target = failure && (failure.kind === 'raw' || failure.kind === 'harness-unavailable') ? failure.target : undefined;
  const provider = failure?.kind === 'harness-unavailable' ? failure.providerId
    : failure?.kind === 'raw' && codexNeedsUpgrade(failure.detail) ? 'codex' : null;
  const key = failure
    ? target && provider ? `session-catalog:${target.machineId ?? 'local'}:${provider}:${target.leg}` : noticeKey
    : previousKey.current;
  if (failure) previousKey.current = key;
  useSessionInputNotice(key, failure ? {
    title: creationFailureCopy(failure, translate), diagnostic: failure,
    ...(failure.kind === 'harness-unavailable' ? { priority: 1, inheritAction: failure.reason !== 'updating' } : {}),
  } : null);
  return null;
}
