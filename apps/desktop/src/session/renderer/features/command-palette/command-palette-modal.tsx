import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { FolderOpen, MessageSquare } from '@/lib/icons';
import { useObserver } from 'mobx-react-lite';
import { useState } from 'react';
import { i18n } from '@/i18n';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { getSessionPageStore } from '@renderer/features/sessions/stores/session-selectors';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { useDebounce } from '@renderer/lib/hooks/useDebounce';
import { getEffectiveHotkey, isHostCommandId } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Shortcut } from '@renderer/lib/ui/shortcut';
import { COMMANDS } from '@shared/commands';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { getCommandIcon } from './command-icons';
import { PALETTE_ITEM_CLASS } from './palette-item-styles';
import { PaletteProjectsGroup } from './palette-projects-group';
import { PaletteChatGroups } from './palette-chats';
import { PaletteSessionItem } from './palette-session-item';
import { rankPaletteMatches } from './palette-rank';
import { followLink } from '@/lib/guguLinks';

interface CommandPaletteProps {
  initialQuery?: string;
}

const GROUP_CLASS = '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-foreground/50';

/** O and P differ only in their initial input; the prefix is the mode's only state. */
export function CommandPaletteModal(props: CommandPaletteProps & BaseModalProps) {
  return <Palette key={props.initialQuery ?? ''} {...props} />;
}

function Palette({ initialQuery = '', onClose }: CommandPaletteProps & BaseModalProps) {
  const [query, setQuery] = useState(initialQuery);
  const commandsMode = query.startsWith('>');
  const search = commandsMode ? query.slice(1).trim() : query.trim();
  const debouncedQuery = useDebounce(search, 100);
  const { navigate } = useNavigate();
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const { translate } = useSessionMessages();
  const { data: results = [] } = useQuery({
    queryKey: ['cmdk-search', debouncedQuery],
    queryFn: () => rpc.search.commandPalette({ query: debouncedQuery }),
    enabled: !commandsMode,
    staleTime: 5_000,
  });
  const commands = useObserver(() => rankPaletteMatches(commandRegistry.activeCommands
    .filter((command, index, all) => command.enabled !== false && !command.hideFromPalette
      && all.findIndex((other) => other.id === command.id) === index)
    .map((command) => {
      const hostId = isHostCommandId(command.id) ? command.id : undefined;
      const def = hostId ? COMMANDS[hostId] : undefined;
      const title = def?.labelKey
        ? def.labelKey.startsWith('main:')
          ? i18n.t(def.labelKey.slice(5), { ns: 'main' })
          : translate(def.labelKey as SessionMessageKey)
        : command.label ?? def?.label ?? command.id;
      return { command, title, description: command.description ?? def?.description ?? '',
        icon: def ? getCommandIcon(def.iconKey) : undefined, hotkey: hostId ? getEffectiveHotkey(hostId, keyboard) : null };
    })
    , search, ({ title, description }) => [title, description]));
  // 本机索引负责召回(短查询的 LIKE 没有分数);排序与 @ 选人同一套,同分保留索引给的顺序。
  const ranked = rankPaletteMatches(results, search, (item) => [item.title], { recallOnly: true });
  const tasks = ranked.filter((item) => item.kind === 'session');
  const projects = ranked.filter((item) => item.kind === 'project');

  return (
    <Command className="flex flex-col overflow-hidden" shouldFilter={false} loop>
      <div className="border-b border-foreground/10 bg-[var(--em-surface-input)] px-1">
        <Command.Input value={query} onValueChange={setQuery}
          placeholder={commandsMode ? translate('palette.commandPlaceholder') : translate('palette.switchPlaceholder')}
          className="w-full bg-transparent px-3 py-3 text-sm outline-none placeholder:text-foreground/40" autoFocus />
      </div>
      <Command.List className="h-96 overflow-y-auto p-1">
        <Command.Empty className="py-8 text-center text-sm text-foreground/40">
          {translate('palette.noResults', { query: search })}
        </Command.Empty>
        {commandsMode ? (
          <Command.Group heading={translate('palette.commands')} className={GROUP_CLASS}>
            {commands.map(({ command, title, icon: Icon, hotkey }) => (
              <Command.Item key={command.id} value={command.id} className={PALETTE_ITEM_CLASS}
                onSelect={() => { onClose(); command.execute(); }}>
                {Icon && <Icon size={14} className="shrink-0 text-foreground/40" />}
                <span className="flex-1 truncate">{title}</span>
                <Shortcut hotkey={hotkey} variant="keycaps" />
              </Command.Item>
            ))}
          </Command.Group>
        ) : (
          <>
            {tasks.length > 0 && (
              <Command.Group heading={translate(search ? 'palette.tasks' : 'palette.recentTasks')} className={GROUP_CLASS}>
                {tasks.map((item) => {
                  const open = () => { if (item.projectId) { onClose(); followLink({ kind: 'session', sessionId: item.id, projectId: item.projectId }); } };
                  const store = item.projectId ? getSessionPageStore(item.projectId, item.id) : undefined;
                  return store ? <PaletteSessionItem key={item.id} value={`task:${item.id}`} sessionPageStore={store} onSelect={open} /> : (
                    <Command.Item key={item.id} value={`task:${item.id}`} onSelect={open} className={PALETTE_ITEM_CLASS}>
                      <MessageSquare size={14} /><span className="flex-1 truncate">{item.title}</span>
                    </Command.Item>
                  );
                })}
              </Command.Group>
            )}
            {search ? projects.length > 0 && (
              <Command.Group heading={translate('palette.projects')} className={GROUP_CLASS}>
                {projects.map((item) => (
                  <Command.Item key={item.id} value={`project:${item.id}`} className={PALETTE_ITEM_CLASS}
                    onSelect={() => { onClose(); navigate('project', { projectId: item.id }); }}>
                    <FolderOpen size={14} /><span className="flex-1 truncate">{item.title}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            ) : <PaletteProjectsGroup currentProjectId={undefined} limit={5} onClose={onClose} navigate={navigate} />}
            <PaletteChatGroups query={search} groupClassName={GROUP_CLASS} onClose={onClose} />
          </>
        )}
      </Command.List>
      <div className="flex items-center gap-4 border-t border-foreground/10 px-3 py-2 text-xs text-foreground/40">
        <span><Shortcut hotkey="ArrowUp" variant="keycaps" /><Shortcut hotkey="ArrowDown" variant="keycaps" /> {translate('common.navigate')}</span>
        <span><Shortcut hotkey="Enter" variant="keycaps" /> {translate('common.select')}</span>
        <span className="ml-auto">{translate('palette.prefixHint')}</span>
      </div>
    </Command>
  );
}
