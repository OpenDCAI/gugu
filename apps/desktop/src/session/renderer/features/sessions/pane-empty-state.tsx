import { ArrowRight, Cable, Folder, Globe, Plus, SquareTerminal } from '@/lib/icons'
import { WORKSPACE_APP_KIND } from '@renderer/features/chats/chat-tabs/chat-panel-item';
import { GitFork, GitPullRequest } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { ExtensionMark } from '@renderer/features/extensions/extension-mark';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { usePaneContext } from '@renderer/features/tabs/pane-context';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  useSessionViewContext,
  useWorkspaceViewModel
} from '@renderer/features/sessions/session-view-context';
import { canStartSideSession, startSideSession } from '@renderer/features/sessions/start-side-session';
import { useArrowKeyNavigation } from '@renderer/lib/hooks/use-arrow-key-navigation';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { cn } from '@renderer/utils/utils';
import type { CommandId } from '@shared/commands';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { workspaceBackend } from './workspace-backend/workspace-backend';
import { useTerminalEnabled } from '@renderer/features/settings/use-terminal-enabled';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { directToolsUnavailableText } from '@renderer/features/remote-hosts/workspace/remote-workspace-routing';

import { STATE_LAYERS } from '@renderer/lib/ui/state-layers';

/**
 * @@@sessionpage layout — workspace-pane empty state. The actions and
 * ordering match the current task context rather than a single global menu.
 */
export function PaneEmptyState() {
  const { pane, paneId } = usePaneContext();
  const { paneLayout } = useWorkspaceViewModel();
  const entries = useSessionWorkspaceActions(
    () => pane.open('browser', { preview: false }),
    (kind) => paneLayout.open(kind, {}, { preview: false, target: { paneId } })
  );

  return <WorkspacePanelActionList entries={entries} />;
}

export function useSessionWorkspaceActions(
  onOpenBrowser: () => void,
  /** 把一个 App 放到这里(它原来在哪就从哪拿走)。 */
  onOpenApp: (kind: string) => void
): WorkspacePanelAction[] {
  const { translate } = useSessionMessages();
  const { projectId, sessionId } = useSessionViewContext();
  const sessionView = useWorkspaceViewModel();
  // spec session-resume 临时会话:分不出来时这一项**渲染成 disabled 并说明原因**,
  // ❌ 不是点了没反应 —— 远程项目没有本地 ACP runtime，未声明 fork 的 provider 也不能冒充。
  const { data: agents } = useAgents();
  const canSideSession = canStartSideSession(projectId, sessionId, agents);
  const terminalEnabled = useTerminalEnabled();

  const actions: Record<SessionWorkspaceActionId, WorkspacePanelAction> = {
    'side-session': {
      id: 'side-session',
      label: translate('workspace.sideTask'),
      icon: <GitFork className="size-3.5" />,
      shortcutSettingsKey: 'session.sideSession',
      disabled: !canSideSession,
      title: canSideSession ? undefined : translate('workspace.sideTaskUnavailable'),
      onClick: () => startSideSession(projectId, sessionId)
    },
    review: {
      id: 'review',
      label: translate('workspace.review'),
      icon: <GitPullRequest className="size-3.5" />,
      onClick: () => sessionView.paneLayout.open('review', {})
    },
    terminal: {
      id: 'terminal',
      label: translate('workspace.terminal'),
      icon: <SquareTerminal className="size-3.5" />,
      onClick: () => void sessionView.openTerminalAsTab()
    },
    browser: {
      id: 'browser',
      label: translate('workspace.browser'),
      icon: <Globe className="size-3.5" />,
      onClick: onOpenBrowser
    },
    ports: {
      id: 'ports',
      label: translate('remotePorts.tool'),
      icon: <Cable className="size-3.5" />,
      onClick: () => sessionView.paneLayout.open('remote-ports', {}, { preview: false })
    },
    // 文件夹:预装的文件夹 App —— 这个对话的文件夹和这条会话的工作目录,一个文件夹两个根(和对话的「+」里同一个)。
    files: {
      id: 'files',
      label: translate('workspace.folder'),
      icon: <Folder className="size-3.5" />,
      onClick: () => onOpenApp(WORKSPACE_APP_KIND)
    }
  };

  // Apps follow the built-ins here for the same reason they do in the「+」menu: their kinds exist only at runtime, so they
  // extend the list instead of joining the union. Both surfaces read the same store, so what the menu offers and what the
  // empty state offers cannot drift (#2374). 与「+」菜单同一套语义(behavior tab-extensions):只列启用的,点一个 =
  // 把它放到这一格(它原来在哪就从哪拿走,一个 App 只有一份,#7052)。
  const extensionActions: WorkspacePanelAction[] = installedExtensionsStore.enabledTabContributions.map(
    (contribution) => ({
      id: contribution.kind,
      label: contribution.title,
      icon: <ExtensionMark iconDataUrl={contribution.iconDataUrl} />,
      section: 'extensions',
      onClick: () => onOpenApp(contribution.kind),
    })
  );

  return [
    ...getSessionWorkspaceActionOrder(projectId, terminalEnabled).map((actionId) =>
      sessionWorkspaceActionBlocked(projectId, actionId)
        ? { ...actions[actionId], disabled: true, title: workspaceBlockedTitle(sessionWorkspaceActionBlocked(projectId, actionId), translate, projectId) }
        : actions[actionId]
    ),
    ...extensionActions,
  ];
}

export type SessionWorkspaceActionId = 'side-session' | 'review' | 'terminal' | 'browser' | 'ports' | 'files';

/**
 * #6264 会话在别的机器上(照 VS Code Remote):与本机同序同项,在浏览器旁边多一格「端口」
 * (本机的端口本来就在这台电脑上,本机会话没有这一格)。只经咕咕云连着的机器用不了的格
 * 由 sessionWorkspaceActionBlocked 灰掉说原因,❌ 从清单里删。
 */
export function getSessionWorkspaceActionOrder(projectId?: string, terminalEnabled = true): SessionWorkspaceActionId[] {
  // 「终端」开关关着:这一格整个不出现(❌ 灰着说原因 —— 普通用户不需要知道有终端;开关在设置 → 通用)。
  const base = localSessionWorkspaceActionOrder().filter((id) => terminalEnabled || id !== 'terminal');
  const backend = projectId ? workspaceBackend(projectId) : null;
  if (!backend || backend.machine.kind === 'local') return base;
  // 「端口」照 VS Code 放在浏览器旁边:只在别的机器上才有意义(本机的端口本来就在这台电脑上)。
  return base.flatMap((id): SessionWorkspaceActionId[] => (id === 'browser' ? [id, 'ports'] : [id]));
}

/**
 * 这一格在这条会话所在的机器上为什么用不了(用得了 = null)。
 * 完整能力披露(owner 2026-09-25「完整能力披露懂不懂」):别的机器上的清单与本机同序同项,
 * 用不了的灰着说原因、原因里带出路,❌ 从清单里删 —— 删了会让人以为产品没这功能。
 * 终端 / 浏览器 / 端口只走直连的路 —— 远程 SSH,或远程隧道的中转(behavior gugu-server-multi-device:网页与终端流量
 * ❌ 走咕咕云的消息通道)。
 */
export function sessionWorkspaceActionBlocked(
  projectId: string | undefined,
  id: SessionWorkspaceActionId
): 'direct-only' | 'cloud-computer' | 'folder-missing' | null {
  // 文件夹 = 预装的文件夹 App:它没装上(装失败只写日志),这一格就灰着说出来,❌ 点了什么都不发生。
  if (id === 'files') return installedExtensionsStore.allTabContributions.some((entry) => entry.kind === WORKSPACE_APP_KIND && entry.enabled) ? null : 'folder-missing';
  if (id !== 'terminal' && id !== 'browser' && id !== 'ports') return null;
  const backend = projectId ? workspaceBackend(projectId) : null;
  if (!backend || backend.machine.kind === 'local') return null;
  const available = id === 'terminal' ? backend.terminal.available : backend.browser.available;
  if (available) return null;
  // #7199 云电脑只经咕咕云连着、谁也没用 SSH 添加过它:原因是「云电脑只有通用」,❌ 说「去用远程 SSH 添加」。
  return remoteHostsStore.device(backend.machine.deviceId)?.cloudComputer ? 'cloud-computer' : 'direct-only';
}

/** 灰掉的那一格悬停说的那句:远程隧道在连 / 连不上的原因照实说(directToolsUnavailableText)。 */
export function workspaceBlockedTitle(
  reason: 'direct-only' | 'cloud-computer' | 'folder-missing' | null,
  translate: ReturnType<typeof useSessionMessages>['translate'],
  projectId?: string
): string | undefined {
  if (!reason) return undefined;
  if (reason === 'folder-missing') return translate('workspace.folderMissing');
  const backend = projectId ? workspaceBackend(projectId) : null;
  const device = backend && backend.machine.kind !== 'local' ? remoteHostsStore.device(backend.machine.deviceId) : null;
  if (device) return directToolsUnavailableText(device, translate);
  return translate(reason === 'cloud-computer' ? 'remoteWorkspace.cloudComputerGeneralOnly' : 'remoteWorkspace.directOnly');
}

function localSessionWorkspaceActionOrder(): SessionWorkspaceActionId[] {
  // 侧边任务排在最前:它是这张单子上**唯一**开一条新会话的动作,其余四项都是给这条会话
  // 配的工具面板。
  //
  // owner 2026-08-21:**「未绑项目」本身不构成「不适用」**。隐式 task-home 一样有工作目录
  // (它本身就是 git 仓库)、一样有可分叉的活跃会话,所以侧边聊天/文件/审阅照给 —— 早先只
  // 给浏览器+终端是当初做减法的临时形态,不是产品终态。够不着的项按 product spec
  // 的既定标准 disabled 并说明原因(见上面 side-session 的 disabled/title),❌ 不从清单里删。
  return ['side-session', 'review', 'terminal', 'browser', 'files'];
}

/**
 * Which group an entry belongs to. Built-ins are the four the app ships; every
 * installed extension lands under one heading instead of being appended to the
 * same list, so a workspace with a dozen extensions still reads as "the things
 * the app does" plus "the things I added" rather than one list that keeps
 * growing. behavior tab-extensions 增量③.
 */
export type WorkspacePanelSection = 'builtin' | 'extensions';

export interface WorkspacePanelAction {
  /**
   * Stable identity for this entry. Titles are free text an extension author
   * chooses (two extensions may both call a tab "Notes", and one may collide
   * with a built-in), so the label cannot be the React key.
   */
  id: string;
  label: string;
  icon: ReactNode;
  section?: WorkspacePanelSection;
  shortcutSettingsKey?: CommandId;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}

/**
 * The list itself: the built-ins, then the Apps. The App group is always drawn — with none installed it is one sentence
 * that leads to the Apps page — because the person opening this to add a tool must find where tools come from here,
 * not in a menu they have not opened (owner, #5265). A row puts that App here (#7052); on and off, and uninstall, are
 * the Apps page's, where every installed App is listed — neither lives here.
 */
export const WorkspacePanelActionList = observer(function WorkspacePanelActionList({
  entries,
}: {
  entries: WorkspacePanelAction[];
}) {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();

  const builtins = entries.filter((entry) => entry.section !== 'extensions');
  const extensions = entries.filter((entry) => entry.section === 'extensions');
  const enabledEntries = entries.filter((entry) => !entry.disabled);

  const { selectedIndex, setSelectedIndex } = useArrowKeyNavigation(
    enabledEntries.length,
    (index) => enabledEntries[index]?.onClick()
  );

  const openExtensionsSettings = () => navigate('apps');

  const renderAction = (entry: WorkspacePanelAction, className?: string) => {
    const enabledIndex = enabledEntries.indexOf(entry);
    return (
      <PaneEmptyStateAction
        className={className}
        disabled={entry.disabled}
        title={entry.title}
        isSelected={enabledIndex >= 0 && selectedIndex === enabledIndex}
        onMouseEnter={() => enabledIndex >= 0 && setSelectedIndex(enabledIndex)}
        onClick={entry.onClick}
        icon={entry.icon}
        label={entry.label}
        shortcutSettingsKey={entry.shortcutSettingsKey}
      />
    );
  };

  return (
    <div className="text-foreground-muted flex h-full min-h-0 items-center justify-center px-4">
      <div
        className="mx-auto flex w-full max-w-sm flex-col gap-0.5"
        data-testid="workspace-panel-actions"
      >
        {builtins.map((entry) => (
          <div key={entry.id} className="flex">
            {renderAction(entry, 'flex-1')}
          </div>
        ))}

        <div
          data-testid="workspace-panel-section-extensions"
          // 一次性 11px → 收进闭合字阶(design.md:type roles are a closed set —— 2026-09-22)。
          className="text-foreground-passive mt-2 flex items-center justify-between pl-2 pr-1 pt-1 text-xs"
        >
          <span>{translate('extensions.appsSection')}</span>
          {/* One door, not two: with nothing enabled the sentence below is the way
              in, so the「+」only appears once there is a list to add to (owner). */}
          {extensions.length > 0 && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={translate('extensions.addAction')}
              title={translate('extensions.addAction')}
              onClick={openExtensionsSettings}
            >
              <Plus className="size-3.5" />
            </Button>
          )}
        </div>

        {extensions.length === 0 ? (
          <button
            type="button"
            data-testid="workspace-panel-extensions-empty"
            onClick={openExtensionsSettings}
            className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-foreground-passive transition-colors hover:bg-row-hover active:bg-row-press hover:text-foreground"
          >
            <span className="min-w-0 flex-1">{translate('extensions.panelEmpty')}</span>
            <ArrowRight className="size-3.5 shrink-0" />
          </button>
        ) : (
          extensions.map((entry) => (
            <div key={entry.id} className="flex">
              {renderAction(entry, 'min-w-0 flex-1')}
            </div>
          ))
        )}
      </div>
    </div>
  );
});

/** 空态清单的一行(别的机器上的会话的工作区空态也用这一行,#6264)。 */
export function PaneEmptyStateAction({
  icon,
  label,
  shortcutSettingsKey,
  isSelected,
  disabled,
  title,
  className,
  onClick,
  onMouseEnter
}: {
  icon: ReactNode;
  label: string;
  shortcutSettingsKey?: CommandId;
  isSelected?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
  onClick?: () => void;
  onMouseEnter?: () => void;
}) {
  return (
    <button
      data-slot="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        'flex min-h-10 w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-foreground-muted transition-colors',
        disabled ? 'opacity-50' : 'hover:bg-row-hover hover:text-foreground',
        isSelected && `bg-background-1 text-foreground hover:bg-background-1 ${STATE_LAYERS}`,
        className
      )}
    >
      <div className="flex items-center gap-2 text-sm">
        {icon}
        {label}
      </div>
      {shortcutSettingsKey && <BoundShortcut commandId={shortcutSettingsKey} variant="keycaps" />}
    </button>
  );
}
