import { observer } from 'mobx-react-lite';
import { appState } from '@renderer/lib/stores/app-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export const ResourceSamplingStatus = observer(function ResourceSamplingStatus() {
  const { translate: t } = useSessionMessages();
  const store = appState.resourceMonitor;
  const failure = store.samplingFailure;
  return <>
    {store.snapshot?.processTreeScope === 'electron-and-pty-roots' && <p className="text-xs text-foreground-muted">{t('resourceMonitor.windowsPartial')}</p>}
    {failure && <p role="alert" className="text-xs text-foreground-muted" data-resource-sampling-error={failure.reason}>
    {t(failure.reason === 'process-list-read-failed' ? 'resourceMonitor.processListFailed' : 'resourceMonitor.sampleFailed')}
    {' · '}{new Date(failure.timestamp).toLocaleTimeString()}
    {store.snapshot && <>{' · '}{t('resourceMonitor.staleData')}</>}
    </p>}
  </>;
});
