import { agentHookService } from '@main/core/agent-hooks/agent-hook-service';
import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';

/**
 * One spawn's native session acknowledgment, plus the turn activity that spawn reports afterwards.
 *
 * Both facts are read from their only writers: `agent:session` (hook service) is the provider's own
 * "my native session exists" edge, and `agent:status` (status writer) is the reading already written.
 * This class re-derives neither.
 *
 * Everything is keyed on `sourceId`, the hook credentials this spawn was started with. A ptyId and a
 * conversationId are both stable across respawns, so they cannot tell a retired generation's late
 * event from the current one's — and a retired event that admitted the current spawn would publish
 * `live` for a session that never came back.
 */
export class LocalSessionAdmission {
  private state: 'pending' | 'ready' | Error = 'pending';
  private readonly waiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  private readonly stopListening: () => void;
  private readonly stopActivity: () => void;
  private turnInFlight = false;

  /**
   * @param expectedNativeSessionId the session this spawn was told to resume. A provider that comes
   * back on a different one silently forked away from the history the reopen promised to preserve.
   */
  constructor(
    private readonly sessionId: string,
    sourceId: string,
    expectedNativeSessionId?: string | null,
  ) {
    this.stopActivity = agentStatusWriter.on('agent:status', (event) => {
      if (event.sourceId !== sourceId) return;
      // Only `working`. Per spec hook-status-derivation `needs_user` means the agent has really
      // stopped and is waiting for a person, and the gate's question is whether reopening would
      // destroy provider work in flight — a prompt waiting on a human is not that. It also has no
      // bound: counting it would defer a credential rotation until someone answers, while messages
      // keep being accepted into a session whose lease is already dead.
      this.turnInFlight = event.reading.status === 'working';
    });
    this.stopListening = agentHookService.on('agent:session', (event) => {
      if (event.sourceId !== sourceId) return;
      if (this.state !== 'pending') return;
      if (expectedNativeSessionId && event.providerSessionId !== expectedNativeSessionId) {
        this.failAdmission(new Error(
          `Local session ${sessionId} resumed a different native session `
          + `(${event.providerSessionId}; expected ${expectedNativeSessionId})`,
        ));
        return;
      }
      this.state = 'ready';
      this.stopListening();
      for (const waiter of this.waiters) waiter.resolve();
      this.waiters.clear();
    });
  }

  /** True while this spawn's own agent is mid-turn; false once it reported a terminal status. */
  isTurnInFlight(): boolean {
    return this.turnInFlight;
  }

  waitUntilReady(): Promise<void> {
    if (this.state instanceof Error) return Promise.reject(this.state);
    if (this.state === 'ready') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failAdmission(new Error(`Local session ${this.sessionId} did not acknowledge its native session within 15000ms`));
      }, 15_000);
      this.waiters.add({
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  /**
   * This spawn's process is gone. Its turn cannot still be running, and nothing it posts afterwards
   * belongs to whatever replaces it.
   */
  dispose(error = new Error(`Local session ${this.sessionId} exited before recovery admission`)): void {
    this.stopActivity();
    this.turnInFlight = false;
    this.failAdmission(error);
  }

  /**
   * The admission itself failed while the process is still running. Turn activity keeps being
   * tracked: reporting a live agent as idle is the one answer that lets the gate reopen on top of
   * a running turn.
   */
  private failAdmission(error: Error): void {
    this.stopListening();
    this.state = error;
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }
}
