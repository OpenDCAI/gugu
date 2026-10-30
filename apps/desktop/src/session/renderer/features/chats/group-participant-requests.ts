import type { ScreenSession } from '@renderer/app/screen-layout';

/** Main still authorizes/imports the session. Its focus notification carries out this renderer-owned placement. */
export class GroupParticipantRequests {
  private sequence = 0;
  private pending = new Map<string, { sourceChatId: string; sequence: number; active: boolean }>();

  cancelAll(): void {
    ++this.sequence;
    for (const request of this.pending.values()) request.active = false;
  }

  prepare(sourceChatId: string, target: ScreenSession): () => void {
    const sequence = ++this.sequence;
    const key = target.sessionId;
    const request = { sourceChatId, sequence, active: true };
    this.pending.set(key, request);
    // Keep a cancelled request until its notification arrives, so it cannot fall through to full-page navigation.
    return () => { request.active = false; };
  }

  take(target: ScreenSession): { sourceChatId?: string; isCurrent?: () => boolean } | undefined {
    // The host may resolve a remote project to its local alias; session identity is stable across that import.
    const key = target.sessionId;
    const request = this.pending.get(key);
    if (!request) return;
    this.pending.delete(key);
    return request.active && request.sequence === this.sequence
      ? { sourceChatId: request.sourceChatId, isCurrent: () => request.active && request.sequence === this.sequence }
      : {};
  }
}

export const groupParticipantRequests = new GroupParticipantRequests();
