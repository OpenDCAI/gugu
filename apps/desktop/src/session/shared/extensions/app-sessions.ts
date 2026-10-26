import type { ImportedTranscript, LocalTranscriptSession, TranscriptContext, TranscriptSource } from '@gugu/core/shared/types/transcripts';

/** External CLI history uses the host's source IDs and parser, including its exclusion of subagents. */
export type AppSessionGroup = { key: string | null; label: string | null; repositoryUrl?: string };
export type AppSessionIndexOptions = { project?: string; source?: TranscriptSource; offset?: number; limit?: number; device?: string; groupPaths?: string[] };
export type AppSessionIndex = { rows: Array<LocalTranscriptSession & { group: AppSessionGroup }>; groups: Array<{ path: string; group: AppSessionGroup }>; total: number; pending: number; stale: boolean; nextOffset: number | null };
export type AppSessionReadOptions = { filePath: string; source: TranscriptSource; offset?: number; limit?: number; view?: 'conversation' | 'context'; device?: string };
export type AppSessionTranscript = ImportedTranscript & { total: number; nextOffset: number | null };
export type AppSessionRead = AppSessionTranscript | TranscriptContext;

export function sessionPageNumber(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (name === 'limit' ? 1 : 0)) {
    throw Object.assign(new Error(`${name} must be ${name === 'limit' ? 'a positive' : 'a nonnegative'} integer`), { code: 'invalid' });
  }
  return value;
}
