import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cachedDevicesAccount } from '@/store/devicesCache';
import { assistantAppClient, reportAssistantAppChange } from '@/components/assistant/assistant-app-client';
import { pendingAssistantWorkSchema } from '@shared/assistant-work';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { AssistantEmpty, AssistantSection } from './assistant-ui';
import type { AssistantContext } from './assistant-context';

/** A recovery view. Clearing it never sends a stop/cancel operation to an executor. */
export function AssistantPendingWork({ context }: { context: AssistantContext }) {
  const { t } = useTranslation('assistant');
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState(false);
  const ownerId = cachedDevicesAccount();
  const app = useMemo(() => assistantAppClient(context.machine, ownerId, true), [context.machine, ownerId]);
  const query = useQuery({
    queryKey: ['assistant-pending-work', ownerId, context.homeDeviceId], enabled: !!context.machine,
    queryFn: async () => {
      const result = await app.callProgram('assistant_work_list');
      if (result.isError) throw new Error('Pending work could not be read');
      return pendingAssistantWorkSchema.parse(result.structuredContent?.result).items;
    },
  });
  useEffect(() => {
    if (!context.machine) return;
    return app.onProgramNotification(event => {
      const params = event.params as { ownerId?: string; resource?: string } | undefined;
      if (params?.ownerId === ownerId && params.resource === 'pending-work') void query.refetch();
    });
  }, [app, context.machine, ownerId, query.refetch]);
  const clear = async () => {
    setClearing(true); setClearError(false);
    try {
      const result = await app.callProgram('assistant_work_clear');
      if (result.isError) throw new Error('Pending work could not be cleared');
      await query.refetch();
      await reportAssistantAppChange(context.machine, context.assistant.id, { resource: 'pending-work', operation: 'removed', id: 'pending-work' });
    } catch { setClearError(true); }
    finally { setClearing(false); }
  };
  return (
    <AssistantSection title={t('memory.pending.title')} testId="assistant-pending-work">
      <details>
        <summary className="ta-page-sub cursor-pointer">{query.data ? t('memory.pending.count', { count: query.data.length }) : t(query.isError ? 'memory.pending.retry' : 'memory.pending.loading')}</summary>
        <p className="ta-page-sub my-2">{t('memory.pending.note')}</p>
        {query.isError ? <button type="button" className="ta-pill-btn" onClick={() => void query.refetch()}>{t('memory.pending.retry')}</button>
          : query.isLoading ? <p className="ta-page-sub">{t('memory.pending.loading')}</p>
            : !query.data?.length ? <AssistantEmpty>{t('memory.pending.empty')}</AssistantEmpty>
              : query.data.map(work => (
                <div key={work.id} className="py-2" data-testid="assistant-pending-work-item">
                  <p>{t(work.state === 'blocked' ? 'memory.pending.blocked' : work.state === 'uncertain' ? 'memory.pending.uncertain' : work.kind === 'question' ? 'memory.pending.question' : 'memory.pending.executor')}</p>
                  {work.source_summary ? <p className="ta-page-sub">{work.source_summary}</p> : null}
                  {work.source_link ? <MarkdownRenderer content={`[${t('memory.pending.source')}](${work.source_link})`} /> : null}
                </div>
              ))}
        {query.data?.length ? <button type="button" className="ta-pill-btn mt-2" disabled={clearing} onClick={() => void clear()}>{t('memory.pending.clear')}</button> : null}
        {clearError ? <p role="alert" className="ta-page-sub">{t('memory.pending.clearFailed')}</p> : null}
      </details>
    </AssistantSection>
  );
}
