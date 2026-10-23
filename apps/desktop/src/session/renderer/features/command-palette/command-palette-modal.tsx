import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Activity, FolderOpen, MessageSquare, type IconComponent } from '@/lib/icons'
import { useObserver } from 'mobx-react-lite';
import React, { useEffect, useMemo, useState } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { getSessionPageStore, getSessionView } from '@renderer/features/sessions/stores/session-selectors';
import { workspaceRegistry } from '@renderer/features/sessions/stores/workspace-registry';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { FileIcon } from '@renderer/lib/editor/file-icon';
import { useDebounce } from '@renderer/lib/hooks/useDebounce';
import { getEffectiveHotkey } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { openShellSettings } from '@renderer/lib/open-shell-settings';
import { Shortcut } from '@renderer/lib/ui/shortcut';
import { cn } from '@renderer/utils/utils';
import { ALL_COMMAND_DEFS, type CommandDef } from '@shared/commands';
import type { SearchItem } from '@shared/core/search';
import { getCommandIcon } from './command-icons';
import { PALETTE_ITEM_CLASS } from './palette-item-styles';
import { PaletteNotificationsGroup } from './palette-notifications-group';
import { PaletteProjectsGroup } from './palette-projects-group';
import { PaletteChatGroups } from './palette-chats';
import { PaletteSessionItem } from './palette-session-item';
import { applyContextAffinity, getPaletteFileDisplayPath } from './search-utils';
import { nudgeWorkspace } from '@renderer/features/sessions/stores/workspace-nudges';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { i18n } from '@/i18n';

interface CommandPaletteProps {
  projectId?: string;
  sessionId?: string;
  workspaceId?: string;
}

interface PaletteAction {
  kind: 'action';
  id: string;
  title: string;
  subtitle?: string;
  shortcut?: ReturnType<typeof getEffectiveHotkey>;
  icon?: IconComponent;
  execute: () => void;
}

const KIND_ICON: Record<string, React.ReactNode> = {
  action: null,
  project: <FolderOpen size={14} className="shrink-0 text-foreground/40" />,
  session: <MessageSquare size={14} className="shrink-0 text-foreground/40" />,
};

const GROUP_CLASS = cn(
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5',
  '[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium',
  '[&_[cmdk-group-heading]]:text-foreground/50'
);

// gugu-dev#181 ⑯ 空着时的「建议操作」:两页顶上那几个入口,在哪一页都是这几个、这个次序。
const SUGGESTED = ['app.newSession', 'app.newGroupChat', 'app.addContact', 'app.newProject', 'app.sessionHistory', 'app.scheduled'];

function PaletteItem({
  value,
  item,
  onSelect,
}: {
  value: string;
  item: SearchItem | PaletteAction;
  onSelect: () => void;
}) {
  const action = item.kind === 'action' ? (item as PaletteAction) : null;
  const ActionIcon = action?.icon;
  const iconNode = ActionIcon ? (
    <ActionIcon size={14} className="shrink-0 text-foreground/40" />
  ) : (
    KIND_ICON[item.kind]
  );
  return (
    <Command.Item value={value} onSelect={onSelect} className={cn(PALETTE_ITEM_CLASS, 'group')}>
      {iconNode}
      <span className="flex-1 truncate">{item.title}</span>
      {action?.shortcut && <Shortcut hotkey={action.shortcut} variant="keycaps" />}
    </Command.Item>
  );
}

function PaletteFileItem({
  value,
  item,
  workspacePath,
  onSelect,
}: {
  value: string;
  item: SearchItem;
  workspacePath?: string;
  onSelect: () => void;
}) {
  const displayPath = getPaletteFileDisplayPath({
    workspacePath,
    filePath: item.id,
    fallback: item.subtitle,
  });

  return (
    <Command.Item value={value} onSelect={onSelect} className={PALETTE_ITEM_CLASS}>
      <FileIcon filename={item.title} size={14} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
        <span className="shrink-0">{item.title}</span>
        <span className="truncate text-xs text-foreground/40">{displayPath}</span>
      </span>
    </Command.Item>
  );
}

export function CommandPaletteModal({
  projectId,
  sessionId,
  workspaceId,
  onClose,
}: CommandPaletteProps & BaseModalProps) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 100);
  const { navigate } = useNavigate();
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const queryClient = useQueryClient();
  const { translate } = useSessionMessages();

  const handleClose = onClose;

  // 搜索被打开:让这个工作区的文件索引重扫一次(一个目录一个 watch 的平台上,没人盯着的目录里新建的文件靠这一下进索引)。
  useEffect(() => {
    if (projectId && workspaceId) void nudgeWorkspace(projectId, workspaceId, { reindex: true });
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  // Prefetch recents immediately on mount so the empty-query view is instant.
  useEffect(() => {
    void queryClient.prefetchQuery({
      queryKey: ['cmdk-search', '', projectId, workspaceId],
      queryFn: () => rpc.search.commandPalette({ query: '', context: { projectId, workspaceId } }),
      staleTime: 5_000,
    });
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  const { data: dbResults = [] } = useQuery({
    queryKey: ['cmdk-search', debouncedQuery, projectId, workspaceId],
    queryFn: () =>
      rpc.search.commandPalette({
        query: debouncedQuery,
        context: { projectId, workspaceId },
      }),
    // Keep results fresh for 5 s — re-opening the palette with the same query
    // returns cached data instantly rather than waiting for a round-trip.
    staleTime: 5_000,
    placeholderData: (prev) => prev,
    // Skip FTS queries that the trigram tokenizer would reject (< 3 chars).
    enabled: debouncedQuery.length === 0 || debouncedQuery.length >= 3,
  });

  // 和侧栏 / 壳里那个入口叫同一个名字(CommandDef.labelKey),跟着界面语言走;没给的照旧写 label。
  const commandTitle = (def: CommandDef | undefined, fallback: string) =>
    !def?.labelKey ? fallback : def.labelKey.startsWith('main:') ? i18n.t(def.labelKey.slice('main:'.length), { ns: 'main' }) : translate(def.labelKey as SessionMessageKey);

  const registryActions = useObserver((): PaletteAction[] =>
    commandRegistry.activeCommands
      .filter((cmd) => cmd.enabled !== false && !cmd.hideFromPalette)
      .map((cmd) => {
        const def = ALL_COMMAND_DEFS.find((d) => d.id === cmd.id) as CommandDef | undefined;
        return {
          kind: 'action' as const,
          id: cmd.id,
          title: commandTitle(def, cmd.label),
          subtitle: cmd.description,
          shortcut: cmd.shortcutKey ? getEffectiveHotkey(cmd.shortcutKey, keyboard) : null,
          icon: getCommandIcon(def?.iconKey),
          execute: () => {
            handleClose();
            cmd.execute();
          },
        };
      })
  );

  const resourceMonitorAction = useMemo<PaletteAction>(
    () => ({
      kind: 'action',
      id: 'resource-monitor',
      title: translate('palette.resourceMonitor'),
      subtitle: translate('palette.resourceMonitorDescription'),
      icon: Activity,
      execute: () => {
        handleClose();
        openShellSettings('resource-monitor');
      },
    }),
    [translate, handleClose],
  );

  const actions = useMemo(() => {
    // Empty state: the suggested actions, in their order.
    return registryActions
      .filter((a) => SUGGESTED.includes(a.id))
      .sort((a, b) => SUGGESTED.indexOf(a.id) - SUGGESTED.indexOf(b.id));
  }, [registryActions]);

  const rankedDb = applyContextAffinity(dbResults, { projectId });
  const actionResults = actions;
  const workspacePath =
    projectId && workspaceId ? workspaceRegistry.get(projectId, workspaceId)?.path : undefined;

  const q = debouncedQuery.toLowerCase();
  const matchedResourceMonitor =
    resourceMonitorAction &&
    q &&
    (resourceMonitorAction.title.toLowerCase().includes(q) ||
      resourceMonitorAction.subtitle?.toLowerCase().includes(q))
      ? resourceMonitorAction
      : null;
  const sessionResults = rankedDb.filter((r): r is SearchItem => r.kind === 'session');

  const handleNavigateToSession = (item: SearchItem) => {
    if (!item.projectId) return;
    handleClose();
    navigate('session', { projectId: item.projectId, sessionId: item.id });
  };

  const handleNavigateToProject = (item: SearchItem) => {
    handleClose();
    navigate('project', { projectId: item.id });
  };

  // 文件结果只在会话页里搜(带着它的工作区),打开在当前这条会话的面板里。
  const handleOpenFile = (item: SearchItem) => {
    if (!item.projectId || !sessionId) return;
    getSessionView(item.projectId, sessionId)?.activePane.open(
      'file',
      { path: item.id },
      { preview: false }
    );
    handleClose();
    navigate('session', { projectId: item.projectId, sessionId: sessionId });
  };

  const handleSelect = (item: SearchItem) => {
    if (item.kind === 'session') return handleNavigateToSession(item);
    if (item.kind === 'project') return handleNavigateToProject(item);
    if (item.kind === 'file') return handleOpenFile(item);
  };

  return (
    <Command className="flex flex-col overflow-hidden" shouldFilter={false} loop>
      <div className="border-b border-foreground/10 bg-[var(--em-surface-input)] px-1">
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder={translate('palette.placeholder')}
          className="w-full bg-transparent px-3 py-3 text-sm outline-none placeholder:text-foreground/40"
          autoFocus
        />
      </div>
      <Command.List className="h-96 overflow-y-auto p-1">
        {query ? (
          <>
            <Command.Empty className="py-8 text-center text-sm text-foreground/40">
              {translate('palette.noResults', { query })}
            </Command.Empty>
            {matchedResourceMonitor && (
              <PaletteItem
                value={matchedResourceMonitor.id}
                item={matchedResourceMonitor}
                onSelect={matchedResourceMonitor.execute}
              />
            )}
            {rankedDb.map((item) => {
              if (item.kind === 'command') {
                const live = commandRegistry.findById(item.id);
                if (!live || live.enabled === false || live.hideFromPalette) return null;
                const def = ALL_COMMAND_DEFS.find((d) => d.id === item.id) as
                  | CommandDef
                  | undefined;
                const shortcut = def?.shortcutKey
                  ? getEffectiveHotkey(def.shortcutKey, keyboard)
                  : null;
                const displayItem: PaletteAction = {
                  kind: 'action',
                  id: item.id,
                  title: commandTitle(def, live.label),
                  subtitle: live.description,
                  shortcut,
                  icon: getCommandIcon(def?.iconKey),
                  execute: () => {
                    handleClose();
                    live.execute();
                  },
                };
                return (
                  <PaletteItem
                    key={item.id}
                    value={item.id}
                    item={displayItem}
                    onSelect={() => {
                      handleClose();
                      live.execute();
                    }}
                  />
                );
              }
              if (item.kind === 'session' && item.projectId) {
                const store = getSessionPageStore(item.projectId, item.id);
                if (store) {
                  return (
                    <PaletteSessionItem
                      key={`session:${item.id}`}
                      sessionPageStore={store}
                      value={`session:${item.id}`}
                      onSelect={() => handleNavigateToSession(item)}
                    />
                  );
                }
              }
              if (item.kind === 'file') {
                return (
                  <PaletteFileItem
                    key={`file:${item.id}`}
                    value={`file:${item.id}`}
                    item={item}
                    workspacePath={workspacePath}
                    onSelect={() => handleOpenFile(item)}
                  />
                );
              }
              return (
                <PaletteItem
                  key={`${item.kind}:${item.id}`}
                  value={`${item.kind}:${item.id}`}
                  item={item}
                  onSelect={() => handleSelect(item)}
                />
              );
            })}
            <PaletteChatGroups query={query} groupClassName={GROUP_CLASS} onClose={handleClose} />
          </>
        ) : (
          <>
            <PaletteNotificationsGroup
              onClose={handleClose}
              navigate={navigate}
            />
            {actionResults.length > 0 && (
              <Command.Group heading={translate('palette.suggestedActions')} className={GROUP_CLASS}>
                {actionResults.map((item) => (
                  <PaletteItem key={item.id} value={item.id} item={item} onSelect={item.execute} />
                ))}
              </Command.Group>
            )}
            {sessionResults.length > 0 && (
              <Command.Group heading={translate('palette.recentTasks')} className={GROUP_CLASS}>
                {sessionResults.slice(0, 5).map((item) => {
                  const store = item.projectId ? getSessionPageStore(item.projectId, item.id) : undefined;
                  return store ? (
                    <PaletteSessionItem
                      key={item.id}
                      sessionPageStore={store}
                      value={item.id}
                      onSelect={() => handleNavigateToSession(item)}
                    />
                  ) : (
                    <PaletteItem
                      key={item.id}
                      value={item.id}
                      item={item}
                      onSelect={() => handleNavigateToSession(item)}
                    />
                  );
                })}
              </Command.Group>
            )}
            {!sessionId && (
              <PaletteProjectsGroup
                currentProjectId={projectId}
                limit={5}
                onClose={handleClose}
                navigate={navigate}
              />
            )}
            <PaletteChatGroups query="" groupClassName={GROUP_CLASS} onClose={handleClose} />
          </>
        )}
      </Command.List>

      <div className="flex items-center gap-4 border-t border-foreground/10 px-3 py-2">
        <span className="flex items-center gap-1 text-xs text-foreground/40">
          <Shortcut hotkey="ArrowUp" variant="keycaps" />
          <Shortcut hotkey="ArrowDown" variant="keycaps" />
          {translate('common.navigate')}
        </span>
        <span className="flex items-center gap-1 text-xs text-foreground/40">
          <Shortcut hotkey="Enter" variant="keycaps" />
          {translate('common.select')}
        </span>
        <span className="flex items-center gap-1 text-xs text-foreground/40">
          <Shortcut hotkey="Escape" variant="keycaps" />
          {translate('common.close')}
        </span>
      </div>
    </Command>
  );
}
