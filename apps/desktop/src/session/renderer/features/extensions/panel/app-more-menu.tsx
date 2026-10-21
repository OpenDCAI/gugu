import { MoreHorizontal } from '@/lib/icons';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import type { SessionTranslate } from '../extension-consent';

/**
 * 装着的 App 那颗 ⋯(#7059,原型「每行一个开关和 ⋯(钉到左栏、在新窗口打开、停用、卸载)」;产品页头上同一颗)。
 * 给不了的那一项就不在:没有一页可开的不给「钉到左栏 / 在新窗口打开」,预装的不给「停用 / 卸载」(咕咕自己的)。
 * 「自动更新」只有市场装的有(owner 10-19,照 VS Code 每个扩展右键里那一格「Auto Update」)。
 */
export function AppMoreMenu({
  name,
  enabled,
  docked,
  disabled = false,
  translate,
  onToggleDock,
  onOpenInWindow,
  onForward,
  onToggleEnabled,
  autoUpdate,
  onUninstall,
  testId,
}: {
  name: string;
  enabled: boolean;
  docked: boolean;
  disabled?: boolean;
  translate: SessionTranslate;
  onToggleDock?: () => void;
  onOpenInWindow?: () => void;
  onForward?: () => void;
  onToggleEnabled?: (enabled: boolean) => void;
  autoUpdate?: { on: boolean; onToggle: (on: boolean) => void };
  onUninstall?: () => void;
  testId?: string;
}) {
  const label = translate('extensions.moreActions', { name });
  const top = [
    onToggleDock && (
      <DropdownMenuItem key="dock" onClick={onToggleDock}>
        {translate(docked ? 'extensions.unpinFromRail' : 'extensions.pinToRail')}
      </DropdownMenuItem>
    ),
    onOpenInWindow && (
      <DropdownMenuItem key="window" onClick={onOpenInWindow}>
        {translate('tabs.openInWindow')}
      </DropdownMenuItem>
    ),
    onForward && (
      <DropdownMenuItem key="forward" onClick={onForward}>
        {translate('extensions.forward')}
      </DropdownMenuItem>
    ),
    onToggleEnabled && (
      <DropdownMenuItem key="enabled" onClick={() => onToggleEnabled(!enabled)}>
        {translate(enabled ? 'extensions.disable' : 'extensions.enable')}
      </DropdownMenuItem>
    ),
    autoUpdate && (
      <DropdownMenuCheckboxItem
        key="auto-update"
        checked={autoUpdate.on}
        onCheckedChange={(on) => autoUpdate.onToggle(on)}
        data-testid="extension-auto-update"
      >
        {translate('extensions.autoUpdate')}
      </DropdownMenuCheckboxItem>
    ),
  ].filter(Boolean);
  if (top.length === 0 && !onUninstall) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            title={label}
            disabled={disabled}
            data-testid={testId}
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44" onClick={(event) => event.stopPropagation()}>
        {top}
        {onUninstall && top.length > 0 ? <DropdownMenuSeparator /> : null}
        {onUninstall ? (
          <DropdownMenuItem variant="destructive" onClick={onUninstall}>
            {translate('extensions.uninstallAction')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
