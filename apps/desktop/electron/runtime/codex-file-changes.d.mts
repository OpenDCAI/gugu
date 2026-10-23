import type { SessionPatch } from '../../../../packages/session-core/src/acp/session-protocol';

export interface CodexFileChange {
  path: string;
  kind: { type: 'add' | 'delete' } | { type: 'update'; move_path: string | null };
  diff: string;
}
export declare function codexFilePatches(item: { changes?: readonly CodexFileChange[] }): Array<SessionPatch & { type: 'diff' }>;
