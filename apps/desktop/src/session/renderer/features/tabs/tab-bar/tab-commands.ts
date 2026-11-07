import type React from 'react';
import type { CommandId } from '@shared/commands';

/**
 * A single actionable entry in a tab context menu (close, rename, …).
 * Renderer-local type — not part of the engine authoring contract.
 */
export interface TabCommand {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Grouping key for separator placement. */
  group?: 'close' | (string & {});
  /**
   * Hotkey binding. Either a user-configurable settings key (resolved via the
   * shortcut settings system) or a getter returning a raw key string.
   */
  shortcut?: CommandId | (() => string | undefined);
  /** Hides the command when false (default: always visible). */
  isAvailable?(): boolean;
  /** The menu holding this command just opened: for what is only worth reading then. */
  onMenuOpen?(): void;
  /** 摆着但灰着(暂时用不了,照 VS Code / Chrome 的页签右键);默认可点。 */
  isEnabled?(): boolean;
  /** 收进这一组的二级菜单(低频,悬浮再展开)。 */
  fold?: true;
  run(): void | Promise<void>;
}
