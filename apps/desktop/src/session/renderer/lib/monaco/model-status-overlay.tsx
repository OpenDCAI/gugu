import type { useModelStatus } from '@renderer/lib/monaco/use-model';
import { Spinner } from '@renderer/lib/ui/spinner';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export function ModelStatusOverlay({ status }: { status: ReturnType<typeof useModelStatus> }) {
  const { translate } = useSessionMessages();
  const message =
    status === 'error'
      ? translate('task.readFileFailed')
      : status === 'binary'
        ? translate('task.unsupportedFileFormat')
      : status === 'too-large'
        ? translate('task.fileTooLarge')
        : translate('task.loading');

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background-secondary-1 text-xs text-foreground-passive">
      <div className="flex items-center gap-2">
        {status === 'loading' ? <Spinner size="sm" /> : null}
        <span>{message}</span>
      </div>
    </div>
  );
}
