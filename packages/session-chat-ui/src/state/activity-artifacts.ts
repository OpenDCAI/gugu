import type { ChatItem, FileChangeSummaryItem, OpenedOutputItem } from '../model';
import { fileChangeSummary, isListedInSummary } from './file-change-summary';
import { openedFilePath, openedOutputKey, type OpenedEntry } from './opened-outputs';

/** Artifacts retain their producing segment; they do not become a separate activity boundary. */
export function activityArtifacts(items: readonly ChatItem[], entries: readonly OpenedEntry[], turnId: string, segmentId: string): Array<FileChangeSummaryItem | OpenedOutputItem> {
  const ids = new Set(items.map(item => item.id));
  const summary = fileChangeSummary([{ items }], turnId);
  const outputs = entries.filter(entry => {
    const path = openedFilePath(entry.output);
    return ids.has(entry.item.id) && (!path || !isListedInSummary(summary, path));
  });
  return [
    ...(summary ? [{ ...summary, id: `${segmentId}:file-changes` }] : []),
    ...outputs.map(({ output }, index): OpenedOutputItem => ({ kind: 'opened-output',
      id: `${segmentId}:output:${openedOutputKey(output)}`, turnId, output, index, count: outputs.length })),
  ];
}
