import type { Hotkey } from '@tanstack/hotkeys';
import type { ContentMenuEntry } from './content-context-menu';

const LABELS = { undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', copyLink: 'Copy Link', paste: 'Paste', selectAll: 'Select All', clear: 'Clear' };
type Action = keyof typeof LABELS;
export interface TextContextMenu {
  selectionText: string;
  labels?: Partial<typeof LABELS>;
  actions: Partial<Record<Action, () => void>>;
  canSelectAll?: boolean;
}

/** One editing model for terminals and file viewers; each host supplies its editing actions. */
export function textContextMenuItems(options: TextContextMenu, extra: ContentMenuEntry[] = []): ContentMenuEntry[] {
  const labels = { ...LABELS, ...options.labels };
  const selected = options.selectionText.length > 0;
  const item = (action: Action, hotkey?: Hotkey, enabled = true): ContentMenuEntry[] => {
    const click = options.actions[action];
    return click ? [{ id: action, label: labels[action], hotkey, enabled, click }] : [];
  };
  return [
    ...item('undo', 'Mod+Z'), ...item('redo', 'Mod+Shift+Z'),
    ...(options.actions.undo || options.actions.redo ? [{ type: 'separator' as const }] : []),
    ...item('cut', 'Mod+X', selected), ...item('copy', 'Mod+C', selected), ...item('copyLink'),
    ...item('paste', 'Mod+V'),
    { type: 'separator' },
    ...item('selectAll', 'Mod+A', options.canSelectAll !== false), ...item('clear'),
    ...(extra.length ? [{ type: 'separator' as const }, ...extra] : []),
  ];
}
