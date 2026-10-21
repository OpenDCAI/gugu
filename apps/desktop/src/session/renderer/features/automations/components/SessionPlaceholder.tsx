import { useSessionMessages } from '@renderer/localization/use-session-messages';

export function SessionPlaceholder({ name }: { name: string | null }) {
  const { translate } = useSessionMessages();
  return (
    <div className="flex h-6 min-w-0 items-center">
      <span className="min-w-0 flex-1 truncate text-sm text-foreground-passive">
        {name ?? translate('automations.creatingTask')}
      </span>
    </div>
  );
}
