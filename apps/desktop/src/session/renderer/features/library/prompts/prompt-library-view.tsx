import { Pencil, Plus, Trash2 } from '@/lib/icons';
import { useMemo, useState } from 'react';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { DeviceScopeNoticeLine } from '@renderer/features/remote-hosts/device-scope-picker';
import { deviceScopeNotice } from '@renderer/features/remote-hosts/device-scope-notice';
import { MultiLineListItem } from '@renderer/lib/components/multi-line-list-item';
import { PageHeader } from '@renderer/lib/components/page-header';
import { PageLoading } from '@renderer/lib/components/page-layout';
import { Button } from '@renderer/lib/ui/button';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { usePromptLibraryActions } from './use-prompt-library-actions';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';

type PromptListItem = {
  id: string;
  title: string;
  prompt: string;
};

function matchesSearch(item: PromptListItem, search: string) {
  if (!search) return true;
  const haystack = `${item.title} ${item.prompt}`.toLowerCase();
  return haystack.includes(search.toLowerCase());
}

function PromptRow({
  item,
  disabled,
  onEdit,
  onDelete,
}: {
  item: PromptListItem;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { translate } = useSessionMessages();
  return (
    <div className="flex w-full">
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={onEdit}
        disabled={disabled}
      >
        <div className="text-md truncate text-foreground">{item.title}</div>
        <div className="mt-1 line-clamp-1 text-xs leading-relaxed text-foreground-muted">
          {item.prompt}
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onEdit}
          disabled={disabled}
          aria-label={translate('prompts.editLabel', { title: item.title })}
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDelete}
          disabled={disabled}
          aria-label={translate('prompts.deleteLabel', { title: item.title })}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

export function PromptLibraryView() {
  const actions = usePromptLibraryActions();
  const { prompts: promptLibrary, createPrompt, editPrompt, deletePrompt } = actions;
  const { translate } = useSessionMessages();
  const host = useLibraryHost();
  // 看的是别的机器、它此刻给不出东西:说一句人话;离线时照旧画上次读到的、只读。一份都没有 ❌ 画「还没有提示词」。
  const notice = deviceScopeNotice(
    { remote: host.remote, error: actions.error, hasData: actions.hasData, now: Date.now(), cloud: remoteHostsStore.cloudScope(host.remote?.deviceId) },
    translate
  );
  const isDisabled = actions.isBusy || !!notice?.readOnly;
  const [search, setSearch] = useState('');

  const filteredItems = useMemo(
    () => promptLibrary.filter((item) => matchesSearch(item, search.trim())),
    [promptLibrary, search]
  );

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        sticky
        title={translate('prompts.title')}
        description={translate('prompts.subtitle')}
        remoteDescription={(device) => translate('deviceScope.subtitle.prompts', { device })}
      >
        <div className="flex w-full justify-between gap-2">
          <SearchInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={translate('prompts.searchPlaceholder')}
          />
          <Button
            onClick={createPrompt}
            disabled={isDisabled}
            aria-label={translate('prompts.new')}
          >
            <Plus className="size-4" />
            <span className="[@container(max-width:520px)]:hidden">{translate('prompts.new')}</span>
          </Button>
        </div>
      </PageHeader>
      {notice && <DeviceScopeNoticeLine notice={notice} onRetry={actions.reload} />}
      {/* 还没读到(在读 / 读不到):❌ 先画一句「还没有提示词」冒充它是空的。读不到时上面那一句说清楚。 */}
      {actions.isLoading ? (
        <PageLoading />
      ) : !actions.hasData ? null : (
        <div className={cn('flex flex-col py-2', filteredItems.length === 0 && 'min-h-64')}>
          {filteredItems.length > 0 ? (
            filteredItems.map((prompt) => (
              <MultiLineListItem key={prompt.id} className="py-3">
                <PromptRow
                  item={prompt}
                  disabled={isDisabled}
                  onEdit={() => editPrompt(prompt)}
                  onDelete={() => deletePrompt(prompt)}
                />
              </MultiLineListItem>
            ))
          ) : (
            <EmptyState
              label={translate('prompts.empty')}
              description={search ? translate('prompts.searchEmpty') : undefined}
            />
          )}
        </div>
      )}
    </div>
  );
}
