import type { ContentMenuItem } from '../content-context-menu';

/** App labels/actions cross the bridge; the shared host keeps presentation and selection. */
export function appContextMenuOf(args: Record<string, unknown>): { x: number; y: number; items: ContentMenuItem[] } {
  if (typeof args.x !== 'number' || !Number.isFinite(args.x) || typeof args.y !== 'number' || !Number.isFinite(args.y) || !Array.isArray(args.items)) {
    throw new Error('showContextMenu needs finite x/y and an items array');
  }
  const ids = new Set<string>();
  const items = args.items.map((raw: unknown): ContentMenuItem => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid context menu item');
    const item = raw as Record<string, unknown>;
    if (item.type === 'separator') return { type: 'separator' };
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.label !== 'string' || !item.label.trim()) throw new Error('Context menu items need unique ids and labels');
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') throw new Error('Context menu enabled must be a boolean');
    ids.add(item.id);
    return { id: item.id, label: item.label, ...(item.enabled === undefined ? {} : { enabled: item.enabled }) };
  });
  return { x: args.x, y: args.y, items };
}
