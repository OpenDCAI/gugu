import { Plus } from '@/lib/icons'
import { PageHeader } from '@renderer/lib/components/page-header';
import { Button } from '@renderer/lib/ui/button';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

interface AutomationsHeaderProps {
  search: string;
  onSearchChange: (value: string) => void;
  createPending: boolean;
  onNewAutomation: () => void;
}

export function AutomationsHeader({
  search,
  onSearchChange,
  createPending,
  onNewAutomation,
}: AutomationsHeaderProps) {
  const { translate } = useSessionMessages();
  return (
    <PageHeader
      title={translate('automations.title')}
      description={translate('automations.subtitle')}
      remoteDescription={(device) => translate('deviceScope.subtitle.automations', { device })}
    >
      <div className="flex items-center justify-between gap-2">
        {/* 「已安排」看哪台机器(#6264)在标题右边(模块层挂的那一份),❌ 挤在搜索框旁。 */}
        <div className="flex min-w-0 items-center gap-2">
          <SearchInput
            placeholder={translate('automations.searchPlaceholder')}
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>
        <Button
          className="shrink-0 whitespace-nowrap"
          disabled={createPending}
          onClick={onNewAutomation}
        >
          <Plus className="h-3.5 w-3.5" />
          {translate('automations.new')}
        </Button>
      </div>
    </PageHeader>
  );
}
