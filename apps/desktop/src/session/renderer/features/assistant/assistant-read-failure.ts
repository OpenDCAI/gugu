import { useEffect, useRef, useState } from 'react';
import { AssistantPanelError } from '@gugu/core/cloud/assistantPanel';
import { ASSISTANT_PANEL_READ_TIMEOUT_MS, isAssistantPanelReadRetryable } from '@gugu/core/cloud/assistantPanelRead';
import { useTranslation } from 'react-i18next';
import { assistantPanelFailure } from '@/components/assistant/assistant-panel-errors';
import { useAssistantPanelAccountId } from '@/lib/assistantPanelBridge';

export type ReadFailure = { text: string; tone: 'quiet' | 'danger'; retry: (() => void) | null };

/** A background fetch must not erase the last failure. Clear it only after a
 * successful read; a stalled initial read becomes a failure after 15 seconds. */
export function useAssistantReadError(loading: boolean, error: unknown, resourceScope = ''): unknown {
  const account = useAssistantPanelAccountId();
  const scope = `${account ?? ''}:${resourceScope}`;
  const [retained,setRetained] = useState<{ scope: string; error: unknown } | null>(null);
  const retainedRef = useRef(retained); retainedRef.current = retained;
  const current = retained?.scope === scope ? retained.error : null;
  useEffect(() => {
    if (error) setRetained(previous => previous?.scope === scope && previous.error === error ? previous : { scope,error });
    else if (!loading) setRetained(null);
    if (!loading || error || retainedRef.current?.scope === scope && retainedRef.current.error) return;
    const timer = setTimeout(() => setRetained({ scope,error: new AssistantPanelError('read-timeout','PANEL_READ_TIMEOUT') }),ASSISTANT_PANEL_READ_TIMEOUT_MS);
    return () => clearTimeout(timer);
  },[loading,error,scope]);
  return error ?? current;
}

/** Read recovery only refreshes cloud state. It never prepares an execution host. */
export function useReadFailure(error: unknown, _deviceId: string | null, _where: string, reload: () => void): ReadFailure | null {
  const { t } = useTranslation('assistant');
  const latest = useRef(reload); latest.current = reload;
  const attempts = useRef(0);
  useEffect(() => {
    if (!error) { attempts.current = 0; return; }
    if (!isAssistantPanelReadRetryable(error)) return;
    const timer = setTimeout(() => latest.current(),Math.min(1500 * 2 ** Math.min(attempts.current++,4),30_000));
    return () => clearTimeout(timer);
  },[error]);
  return error ? { text: assistantPanelFailure(error,t),tone: (error as { code?: string }).code === 'unprepared' ? 'quiet' : 'danger',retry: null } : null;
}
