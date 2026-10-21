import { AlertCircle } from '@/lib/icons'
import { PRODUCT_NAME } from '@shared/app-identity';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export function ServerUnavailableMessage() {
  const { translate } = useSessionMessages();
  return (
    <div className="bg-background-2/20 flex items-center gap-2 rounded-md px-3 py-2">
      <AlertCircle className="text-foreground-muted h-3.5 w-3.5 shrink-0" />
      <p className="text-foreground-muted text-xs">
        {translate('error.serverUnavailable', { appName: PRODUCT_NAME })}
      </p>
    </div>
  );
}
