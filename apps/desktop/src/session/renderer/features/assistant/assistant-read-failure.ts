import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { assistantPanelFailure } from '@/components/assistant/assistant-panel-errors';

export type ReadFailure = { text: string; tone: 'quiet' | 'danger'; retry: (() => void) | null };

/** Read recovery only refreshes cloud state. It never prepares an execution host. */
export function useReadFailure(error: unknown, _deviceId: string | null, _where: string, reload: () => void): ReadFailure | null {
  const { t } = useTranslation('assistant');
  const latest = useRef(reload); latest.current = reload;
  const attempts = useRef(0);
  useEffect(() => {
    if (!error) { attempts.current = 0; return; }
    const timer = setTimeout(() => latest.current(),Math.min(1500 * 2 ** Math.min(attempts.current++,4),30_000));
    return () => clearTimeout(timer);
  },[error]);
  return error ? { text: assistantPanelFailure(error,t),tone: (error as { code?: string }).code === 'unprepared' ? 'quiet' : 'danger',retry: null } : null;
}
