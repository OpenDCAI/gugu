import { getRendererSession } from '@/lib/sessionPublication';
import { browserStorage } from '@renderer/features/remote-hosts/remote-recent-folders';

const key = (owner: string) => `gugu:recent-tasks:${owner}`;
export function recentTaskIds(owner = getRendererSession()?.user.id ?? null): string[] {
  if (!owner) return [];
  try {
    const ids: unknown = JSON.parse(browserStorage()?.getItem(key(owner)) ?? '[]');
    return Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string'))].slice(0, 20) : [];
  } catch { return []; }
}

/** Desktop-local navigation history; never changes a task's shared interaction time. */
export function rememberTask(id: string, archived = false, owner = getRendererSession()?.user.id ?? null): void {
  if (!owner) return;
  const rest = recentTaskIds(owner).filter((item) => item !== id);
  try { browserStorage()?.setItem(key(owner), JSON.stringify((archived ? rest : [id, ...rest]).slice(0, 20))); }
  catch { /* Unavailable storage must not prevent opening or archiving a task. */ }
}
