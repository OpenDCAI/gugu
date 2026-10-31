import type { ScreenSession } from '@renderer/app/screen-layout';

export type GroupParticipantRequest = (() => void) & { requestId: string };

/** Main still authorizes/imports the session. Its focus notification carries out this renderer-owned placement. */
export class GroupParticipantRequests {
  private sequence = 0;
  private pending = new Map<string, { sourceChatId: string; sessionId: string; sequence: number; active: boolean }>();

  cancelAll(): void {
    ++this.sequence;
    for (const request of this.pending.values()) request.active = false;
    this.pending.clear();
  }

  prepare(sourceChatId: string, target: ScreenSession): GroupParticipantRequest {
    const sequence = ++this.sequence;
    const requestId = crypto.randomUUID();
    const request = { sourceChatId, sessionId: target.sessionId, sequence, active: true };
    this.pending.set(requestId, request);
    return Object.assign(() => {
      request.active = false;
      this.pending.delete(requestId);
    }, { requestId });
  }

  take(target: ScreenSession, requestId?: string): { sourceChatId?: string; isCurrent?: () => boolean } | undefined {
    // Ordinary focus events cannot be a receipt for a group click, even for the same session.
    if (!requestId) { this.cancelAll(); return; }
    // The host may resolve a remote project to its local alias; session identity is stable across that import.
    const request = this.pending.get(requestId);
    // A cancelled/old receipt is consumed without turning into ordinary navigation.
    if (!request || request.sessionId !== target.sessionId) return {};
    this.pending.delete(requestId);
    return request.active && request.sequence === this.sequence
      ? { sourceChatId: request.sourceChatId, isCurrent: () => request.active && request.sequence === this.sequence }
      : {};
  }
}

export const groupParticipantRequests = new GroupParticipantRequests();
