import { detectPlatform, parseHotkey } from '@tanstack/react-hotkeys';
import { observer } from 'mobx-react-lite';
import { Fragment, type ReactNode } from 'react';
import type { TabHost } from '@renderer/features/tabs/core/tab-host';
import type { ResolvedTab, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/lib/ui/context-menu';
import { toast } from '@renderer/lib/hooks/use-toast';
import { BoundShortcut, Shortcut } from '@renderer/lib/ui/shortcut';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { ShortcutSettingsKey } from '@shared/shortcuts';
import type { TabCommand } from './tab-commands';

const _PLATFORM = detectPlatform();

/** Renders a shortcut hint that works with both a settings key and a raw getter. */
function CmdShortcut({
  shortcut,
}: {
  shortcut?: ShortcutSettingsKey | (() => string | undefined);
}) {
  if (!shortcut) return null;
  if (typeof shortcut === 'function') {
    const raw = shortcut();
    // oxlint-disable-next-line typescript/no-explicit-any
    const parsed = raw ? (parseHotkey(raw, _PLATFORM) as any) : null;
    return parsed ? <Shortcut hotkey={parsed} className="ml-auto" /> : null;
  }
  return <BoundShortcut settingsKey={shortcut} className="ml-auto" />;
}

/**
 * 任何一类页签的右键(spec session-page「一屏几块」,照原型):
 *   关闭页签 / 关闭其他页签 / 关闭右侧页签 / 关闭全部页签(照 VS Code、Chrome;暂时用不了的灰着,❌ 藏掉)
 *   ── 拆开(并排的一对才有)/ 向右分 / 向下分(在能分格的布局里一直摆着;这一格只有这一枚、或分满了,点了说为什么)/ 在新窗口打开 /
 *      移到另一栏(这条会话不止一格时)
 *   ── 这类页签自己的命令(`kindCommands`,比如会话那枚的置顶、重命名、归档)。
 * 一组里一项都没有就连分隔线一起不画。
 */
export const TabContextMenu = observer(function TabContextMenu({
  tab,
  host,
  ctx: _ctx,
  kindCommands = [],
  children,
}: {
  tab: ResolvedTab;
  host: TabHost;
  ctx: TabViewContext;
  kindCommands?: TabCommand[];
  children: ReactNode;
}) {
  const { translate } = useSessionMessages();
  const index = host.resolvedTabs.findIndex((t) => t.tabId === tab.tabId);
  const count = host.resolvedTabs.length;
  const engineCommands: TabCommand[] = [
    ...(tab.isPreview
      ? [{ id: 'engine:keep-open', label: translate('tabs.keepOpen'), group: 'close' as const, run: () => host.pin(tab.tabId) }]
      : []),
    {
      id: 'engine:close',
      label: translate('tabs.close'),
      group: 'close' as const,
      shortcut: 'tabClose' as const,
      run: () => host.requestCloseTab(tab.tabId),
    },
    {
      id: 'engine:close-others',
      label: translate('tabs.closeOthers'),
      group: 'close' as const,
      isEnabled: () => count > 1,
      run: () => host.closeOthers(tab.tabId),
    },
    {
      id: 'engine:close-right',
      label: translate('tabs.closeRight'),
      group: 'close' as const,
      isEnabled: () => index >= 0 && index < count - 1,
      run: () => host.closeToRight(tab.tabId),
    },
    {
      id: 'engine:close-all',
      label: translate('tabs.closeAll'),
      group: 'close' as const,
      run: () => host.closeAll(),
    },
  ];
  // 向右分 / 向下分 = 和屏上那页并排(spec session-page「并排」)。分不出去也摆着,点了说为什么:没有别的页可并排 / 太窄(太矮)放不下两页。
  const split = (edge: 'right' | 'bottom') => {
    const blocked = host.tabSplitBlocked(tab.tabId, edge);
    if (blocked === null) {
      host.splitTab(tab.tabId, edge);
      return;
    }
    const reason = blocked === 'only-tab' ? 'tabs.splitOnlyTab' : blocked === 'full' ? 'tabs.splitFull' : edge === 'right' ? 'tabs.splitTooNarrow' : 'tabs.splitTooShort';
    toast({ title: translate(reason) });
  };
  const splitCommands: TabCommand[] = [
    // 并排的一对:「拆开」= 两枚都变回普通页签,点着的那枚占满(spec session-page「并排」,照 Chrome「Separate views」)。
    ...(tab.pairRole
      ? [{ id: 'engine:separate-pair', label: translate('tabs.separatePair'), group: 'split' as const, run: () => host.separatePair() }]
      : []),
    {
      id: 'engine:split-right',
      label: translate('tabs.splitRight'),
      group: 'split' as const,
      shortcut: 'splitPane' as const,
      isEnabled: () => host.inSplitLayout,
      run: () => split('right'),
    },
    {
      id: 'engine:split-down',
      label: translate('tabs.splitDown'),
      group: 'split' as const,
      isEnabled: () => host.inSplitLayout,
      run: () => split('bottom'),
    },
  ];
  // 分隔线下面:向右分 / 向下分 / 在新窗口打开 / 移到另一栏(spec session-page「页签右键」)。
  const openInWindow = host.tabWindowOpener(tab.tabId);
  if (openInWindow) {
    splitCommands.push({ id: 'engine:open-in-window', label: translate('tabs.openInWindow'), group: 'split' as const, run: openInWindow });
  }
  const moveToOtherPane = host.tabMoveToOtherPane(tab.tabId);
  if (moveToOtherPane) {
    splitCommands.push({ id: 'engine:move-to-other-pane', label: translate('tabs.moveToOtherPane'), group: 'split' as const, run: moveToOtherPane });
  }

  const groups = [engineCommands, splitCommands, kindCommands]
    .map((commands) => commands.filter((c) => c.isAvailable?.() !== false))
    .filter((commands) => commands.length > 0);

  return (
    <ContextMenu>
      {/* 这层 trigger 长在 .session-tab-slot **里面**(见 generic-tab-item.tsx 的说明),所以它必须
          把 slot 填满并允许自己被压缩:`w-full` 撑满分到的宽度,`min-w-0` 解除 flex 的自动最小尺寸
          —— 少了 min-w-0,页签标题的 min-content 会变成一道压不下去的地板,slot 缩了它也不缩,
          于是标题溢出到邻居身上。 */}
      <ContextMenuTrigger className="flex h-full w-full min-w-0">{children}</ContextMenuTrigger>
      <ContextMenuContent finalFocus={false}>
        {groups.map((commands, groupIndex) => (
          <Fragment key={commands[0].id}>
            {groupIndex > 0 && <ContextMenuSeparator />}
            {commands.map((cmd) => (
              <ContextMenuItem key={cmd.id} disabled={cmd.isEnabled?.() === false} onClick={() => void cmd.run()}>
                {cmd.icon ? <cmd.icon className="size-4" /> : null}
                {cmd.label}
                <CmdShortcut shortcut={cmd.shortcut} />
              </ContextMenuItem>
            ))}
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
});
