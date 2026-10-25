import { Menu, type MenuItemConstructorOptions, type PopupOptions } from 'electron';

const LABELS = { undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', copyLink: 'Copy Link', paste: 'Paste', selectAll: 'Select All', clear: 'Clear' };
type Action = keyof typeof LABELS;
export interface NativeTextMenu {
  selectionText: string;
  labels?: Partial<typeof LABELS>;
  actions: Partial<Record<Action, () => void>>;
  canSelectAll?: boolean;
}

/** Terminals and file viewers share the native editing menu, including its shortcuts and enabled states. */
export function nativeTextMenuTemplate(options: NativeTextMenu, extra: MenuItemConstructorOptions[] = []): MenuItemConstructorOptions[] {
  const labels = { ...LABELS, ...options.labels };
  const selected = options.selectionText.length > 0;
  const item = (action: Action, accelerator?: string, enabled = true): MenuItemConstructorOptions[] => {
    const click = options.actions[action];
    return click ? [{ label: labels[action], accelerator, enabled, click }] : [];
  };
  return [
    ...item('undo', 'CmdOrCtrl+Z'), ...item('redo', 'CmdOrCtrl+Shift+Z'),
    ...(options.actions.undo || options.actions.redo ? [{ type: 'separator' as const }] : []),
    ...item('cut', 'CmdOrCtrl+X', selected), ...item('copy', 'CmdOrCtrl+C', selected), ...item('copyLink'),
    ...item('paste', 'CmdOrCtrl+V'),
    { type: 'separator' },
    ...item('selectAll', 'CmdOrCtrl+A', options.canSelectAll !== false), ...item('clear'),
    ...(extra.length ? [{ type: 'separator' as const }, ...extra] : []),
  ];
}

export function popupNativeTextMenu(options: NativeTextMenu, popup: PopupOptions, extra?: MenuItemConstructorOptions[]): void {
  Menu.buildFromTemplate(nativeTextMenuTemplate(options, extra)).popup(popup);
}
