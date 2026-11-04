import type { RemovedSessionIdentity } from '@gugu/core/shared/sessionArchival';

/** Identity belongs to the host; the session backend owns archive/restore ordering. */
export interface SessionIdentityHost {
  archive(sessionId: string, confirmedRemoval?: RemovedSessionIdentity): Promise<RemovedSessionIdentity | null>;
  release(identity: RemovedSessionIdentity): Promise<void>;
  restore(target: { projectId: string; sessionId: string }, identity: RemovedSessionIdentity): Promise<void>;
}

let host: SessionIdentityHost | null = null;

export function setSessionIdentityHost(next: SessionIdentityHost | null): void {
  host = next;
}

export function sessionIdentityHost(): SessionIdentityHost {
  if (!host) throw new Error('Removing the identity needs a connection; retry, or archive without removing it.');
  return host;
}
