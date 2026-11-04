import { parseGroupFileLink } from '@gugu/core/shared/ui/guguLink';

export type TaskPageFileRef = { file: string; expectedVersion?: number };
export type TaskPageFilePayload = { name: string; mimeType: string; bytes: ArrayBuffer; version: number };
export const TASK_PAGE_FILE_COUNT_MAX = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => Object.assign(new Error('Give at most eight file-card references with optional expectedVersion; local paths are unavailable'), { code: 'invalid' });

/** File cards only, never paths, workspace references or an App-selected actor. */
export function taskPageFileRefs(value: unknown): { itemId: string; expectedVersion?: number }[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > TASK_PAGE_FILE_COUNT_MAX) throw invalid();
  const seen = new Set<string>();
  return value.map(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || !Object.hasOwn(ref, 'file') || typeof ref.file !== 'string'
      || Object.keys(ref).some(key => key !== 'file' && key !== 'expectedVersion')) throw invalid();
    if (ref.expectedVersion !== undefined && typeof ref.expectedVersion !== 'number') throw invalid();
    const link = parseGroupFileLink(ref.file);
    const itemId = link?.itemId ?? (UUID.test(ref.file) ? ref.file : undefined);
    if (!itemId) throw invalid();
    if (link) {
      const query = new URL(ref.file).searchParams;
      if ([...query.keys()].some(key => key !== 'v') || query.getAll('v').length > 1
        || query.has('v') && link.version === undefined) throw invalid();
    }
    const version = ref.expectedVersion ?? link?.version;
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)
      || ref.expectedVersion !== undefined && link?.version !== undefined && ref.expectedVersion !== link.version) throw invalid();
    if (seen.has(itemId.toLowerCase())) throw invalid();
    seen.add(itemId.toLowerCase());
    return { itemId, ...(version === undefined ? {} : { expectedVersion: version }) };
  });
}
