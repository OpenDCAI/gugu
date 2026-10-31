import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promptInputSchema, type PromptInput, type QueuedPrompt } from '@gugu/session-core/acp';
import type { PromptQueueStore } from '../runtime/types';

/** Persist the runtime machine's pending inputs as one atomic per-conversation snapshot. */
export class LocalPromptQueueStore implements PromptQueueStore {
  constructor(private readonly rootDir: string) {}

  load(sessionId: string): readonly PromptInput[] {
    const path = this.pathFor(sessionId);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const result = promptInputSchema.array().safeParse(JSON.parse(raw));
    if (!result.success) {
      throw new Error(`Prompt queue snapshot '${path}' is invalid`, { cause: result.error });
    }
    return result.data;
  }

  save(sessionId: string, prompts: readonly QueuedPrompt[]): void {
    const path = this.pathFor(sessionId);
    mkdirSync(dirname(path), { recursive: true });
    // A renderer-only edit reservation must not strand the queue after a runtime restart.
    // Persist the last committed prompt, never its unsaved edit or another composer draft.
    const inputs = prompts.map(({ id: _id, createdAt: _createdAt, updatedAt: _updatedAt, queueEdit: _queueEdit,
      queueDispatching: _queueDispatching, ...input }) => input);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify(inputs));
    renameSync(temporary, path);
  }

  clear(sessionId: string): void {
    try {
      unlinkSync(this.pathFor(sessionId));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  private pathFor(sessionId: string): string {
    return join(this.rootDir, `${encodeURIComponent(sessionId)}.json`);
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
