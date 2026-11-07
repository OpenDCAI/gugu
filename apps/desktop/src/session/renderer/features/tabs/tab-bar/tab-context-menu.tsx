import { detectPlatform, type Hotkey } from '@tanstack/react-hotkeys';
import { observer } from 'mobx-react-lite';
import { Fragment, type ReactNode } from 'react';
import type { TabHost } from '@renderer/features/tabs/core/tab-host';
import type { ResolvedTab, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import { MoreHorizontal } from '@/lib/icons';
import { ContextMenu, MenuFold, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { toast } from '@renderer/lib/hooks/use-toast';
import { formatHotkeyText } from '@renderer/lib/ui/shortcut-format';
import { getEffectiveHotkey } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { TabCommand } from './tab-commands';

const _PLATFORM = detectPlatform();

/** A command's shortcut as menu text: a bound command's current hotkey, or a raw getter's hotkey. */
function shortcutText(shortcut: TabCommand['shortcut'], keyboard: Parameters<typeof getEffectiveHotkey>[1]): string | undefined {
  if (!shortcut) return undefined;
  const hotkey = typeof shortcut === 'function' ? shortcut() : getEffectiveHotkey(shortcut, keyboard);
  return hotkey ? formatHotkeyText(hotkey as Hotkey, _PLATFORM) : undefined;
}

/**
 * 任何一类页签的右键(spec session-page「一屏几块」,照原型):
 *   关闭页签 / 关闭多个页签 ▸ 其他、右侧、全部(照 VS Code、Chrome;暂时用不了的灰着,❌ 藏掉)
 *   ── 拆开(并排的一对才有)/ 向右分(在能分屏的地方一直摆着;没有别的页、或太窄,点了说为什么)/ 在新窗口打开
 *   ── 这类页签自己的命令(`kindCommands`,比如会话那枚的置顶、重命名、归档;标了 `fold` 的进「更多」)。
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
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const index = host.resolvedTabs.findIndex((t) => t.tabId === tab.tabId);
  const count = host.resolvedTabs.length;
  const engineCommands: TabCommand[] = [
    {
      id: 'engine:close',
      label: translate('tabs.close'),
      group: 'close' as const,
      shortcut: 'session.tabClose' as const,
      run: () => host.requestCloseTab(tab.tabId),
    },
    {
      id: 'engine:close-others',
      fold: true,
      label: translate('tabs.closeOthers'),
      group: 'close' as const,
      isEnabled: () => count > 1,
      run: () => host.closeOthers(tab.tabId),
    },
    {
      id: 'engine:close-right',
      fold: true,
      label: translate('tabs.closeRight'),
      group: 'close' as const,
      isEnabled: () => index >= 0 && index < count - 1,
      run: () => host.closeToRight(tab.tabId),
    },
    {
      id: 'engine:close-all',
      fold: true,
      label: translate('tabs.closeAll'),
      group: 'close' as const,
      run: () => host.closeAll(),
    },
  ];
  // 向右分 = 和屏上那页并排(spec session-page「并排」)。分不出去也摆着,点了说为什么:没有别的页可并排 / 太窄放不下两页。
  const split = () => {
    const blocked = host.tabSplitBlocked(tab.tabId);
    if (blocked === null) {
      host.splitTab(tab.tabId);
      return;
    }
    toast({ title: translate(blocked === 'only-tab' ? 'tabs.splitOnlyTab' : 'tabs.splitTooNarrow') });
  };
  const splitCommands: TabCommand[] = [
    // 并排的一对:「拆开」= 两枚都变回普通页签,点着的那枚占满(spec session-page「并排」,照 Chrome「Separate views」)。
    ...(tab.pairRole
      ? [{ id: 'engine:separate-pair', label: translate('tabs.separatePair'), group: 'split' as const, shortcut: 'session.splitPane' as const, run: () => host.separatePair() }]
      : []),
    {
      id: 'engine:split-right',
      label: translate('tabs.splitRight'),
      group: 'split' as const,
      ...(tab.pairRole ? {} : { shortcut: 'session.splitPane' as const }),
      isEnabled: () => host.inSplitLayout,
      run: split,
    },
  ];
  // 分隔线下面:拆开 / 向右分 / 在新窗口打开(spec session-page「页签右键」)。
  const openInWindow = host.tabWindowOpener(tab.tabId);
  if (openInWindow) {
    splitCommands.push({ id: 'engine:open-in-window', label: translate('tabs.openInWindow'), group: 'split' as const, run: openInWindow });
  }

  const groups = [engineCommands, splitCommands, kindCommands]
    .map((commands) => commands.filter((c) => c.isAvailable?.() !== false))
    .filter((commands) => commands.length > 0);

  const row = (cmd: TabCommand) => (
    <MenuItem key={cmd.id} icon={cmd.icon ? <cmd.icon /> : undefined} shortcut={shortcutText(cmd.shortcut, keyboard)} disabled={cmd.isEnabled?.() === false} onClick={() => void cmd.run()}>
      {cmd.label}
    </MenuItem>
  );

  return (
    <ContextMenu.Root onOpenChange={(open) => { if (open) kindCommands.forEach((cmd) => cmd.onMenuOpen?.()); }}>
      {/* 这层 trigger 长在 .session-tab-slot **里面**(见 generic-tab-item.tsx 的说明),所以它必须
          把 slot 填满并允许自己被压缩:`w-full` 撑满分到的宽度,`min-w-0` 解除 flex 的自动最小尺寸
          —— 少了 min-w-0,页签标题的 min-content 会变成一道压不下去的地板,slot 缩了它也不缩,
          于是标题溢出到邻居身上。 */}
      <ContextMenu.Trigger className="flex h-full w-full min-w-0">{children}</ContextMenu.Trigger>
      <ContextMenu.Content finalFocus={false}>
        {groups.map((commands, groupIndex) => (
          <Fragment key={commands[0].id}>
            {groupIndex > 0 && <MenuSeparator />}
            {commands.filter((cmd) => !cmd.fold).map(row)}
            <MenuFold {...(commands[0].group === 'close' ? { label: translate('tabs.closeMany') } : { icon: <MoreHorizontal />, label: translate('common.more') })}>{commands.filter((cmd) => cmd.fold).map(row)}</MenuFold>
          </Fragment>
        ))}
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
});
