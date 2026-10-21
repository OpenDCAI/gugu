import { useSessionMessages } from '@renderer/localization/use-session-messages';

export function AutomationsBreadcrumb() {
  const { translate } = useSessionMessages();
  return (
    <nav
      aria-label={translate('automations.breadcrumbLabel')}
      className="flex items-center px-2"
    >
      <span className="max-w-[14rem] truncate rounded-sm px-1 py-0.5 text-sm text-foreground">
        {translate('automations.title')}
      </span>
    </nav>
  );
}
