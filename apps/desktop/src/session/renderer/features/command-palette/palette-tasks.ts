import type { SearchItem } from '@shared/core/search';
import { isAssistantSession, type ListedSession } from '@renderer/features/assistant/assistant-lineage';
import { formatSessionTitleForDisplay } from '@renderer/features/sessions/session-title-utils';
import { rowOpens } from '@/session/shared/remote-sessions/session-directory';
import { rankPaletteMatches } from './palette-rank';

export type PaletteTask = SearchItem & { deviceId?: string; deviceLabel?: string };
export type ListedPaletteTask = ListedSession & { deviceLabel: string };

/** The existing local recall and device directory share one recent/title list. */
export function paletteTasks(local: readonly SearchItem[], listed: readonly ListedPaletteTask[], query: string, assistantId: string | null): PaletteTask[] {
  const tasks = new Map<string, PaletteTask>(local.filter(item => item.kind === 'session').map(item => [item.id, item]));
  const remote = listed
    .filter(({ summary }) => rowOpens(summary) && !isAssistantSession(summary, assistantId))
    .map(({ deviceId, deviceLabel, summary }): PaletteTask => ({
      kind: 'session', id: summary.conversationId, projectId: summary.projectId,
      title: formatSessionTitleForDisplay(summary.harness, summary.title),
      subtitle: '', score: 0, lastInteractedAt: summary.lastInteractedAt, deviceId, deviceLabel,
    }));
  for (const item of rankPaletteMatches(remote, query, item => [item.title])) {
    if (!tasks.has(item.id)) tasks.set(item.id, item);
  }
  const merged = [...tasks.values()];
  if (query.trim()) return rankPaletteMatches(merged, query, item => [item.title], { recallOnly: true });
  const at = (item: SearchItem) => item.lastInteractedAt ? new Date(item.lastInteractedAt).getTime() : Number.NEGATIVE_INFINITY;
  return merged.sort((a, b) => at(b) - at(a)).slice(0, 10);
}
