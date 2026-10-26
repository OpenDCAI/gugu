import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import type { MachineReadiness } from './assistant-data';
import { useAssistantReadError, useReadFailure } from './assistant-read-failure';
import { AssistantEmpty } from './assistant-ui-parts';
import { isAssistantPanelReadRetryable } from '@gugu/core/cloud/assistantPanelRead';

export * from './assistant-ui-parts';

/** Read state belongs to the cloud copy, independently of the execution host. */
export function MachineGate({ loading, error, onRetry, children, hasData = false, failedTitle }: {
  readiness: MachineReadiness; loading: boolean; error: unknown; onRetry: () => void; children: ReactNode; hasData?: boolean; failedTitle?: string;
}) {
  const { t } = useTranslation('assistant');
  const readError = useAssistantReadError(loading,error);
  const failure = useReadFailure(readError,null,'',onRetry);
  if (hasData) return <>{children}{failure && !isAssistantPanelReadRetryable(readError) ? <p className="ta-page-sub" role="status">{failure.text}</p> : null}</>;
  if (failure) return <AssistantEmpty title={failedTitle} action={failure.retry ? (
    <button type="button" className="ta-pill-btn" onClick={failure.retry}>{t('machine.retry')}</button>
  ) : undefined}><span role={failure.tone === 'danger' ? 'alert' : 'status'}>{failure.text}</span></AssistantEmpty>;
  if (loading) return <AssistantEmpty><LoadingIndicator size="inline" /></AssistantEmpty>;
  return <>{children}</>;
}
