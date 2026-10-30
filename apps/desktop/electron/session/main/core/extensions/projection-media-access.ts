import type { BridgeCaller } from './extension-bridge';
import type { ExtensionProjections } from './extension-projections';

type Access = { pageId: number; release(): void };

/** Main-process authority for media. No caller can create it by sending a session id in SDP/RPC. */
export class ProjectionMediaAccess {
  private readonly active = new Set<Access>();

  constructor(private readonly resources: ExtensionProjections, private readonly epochOf: (pageId: number) => number) {}

  open(caller: BridgeCaller, sourceId: string) {
    if (caller.kind !== 'page' || !caller.binding?.sessionId) throw new Error('Projection media needs a bound task page');
    const { extensionId, pageId } = caller;
    const sessionId = caller.binding.sessionId;
    const epoch = this.epochOf(pageId);
    if (this.active.size >= 64 || [...this.active].filter(access => access.pageId === pageId).length >= 16) {
      throw new Error('Too many projection media bindings');
    }
    const source = this.resources.sourceAccess({ extensionId, sessionId }, sourceId);
    const lifetime = new AbortController();
    const release = () => {
      source.signal.removeEventListener('abort', release);
      this.active.delete(access);
      lifetime.abort(source.signal.aborted ? source.signal.reason : new Error('Projection media authority released'));
    };
    const access = { pageId, release };
    this.active.add(access);
    source.signal.addEventListener('abort', release, { once: true });
    const assertCurrent = () => {
      try {
        lifetime.signal.throwIfAborted();
        source.assertCurrent();
        if (caller.kind !== 'page' || caller.extensionId !== extensionId || caller.pageId !== pageId
          || caller.binding?.sessionId !== sessionId || this.epochOf(pageId) !== epoch) {
          throw new Error('Projection media page binding changed');
        }
      } catch (error) {
        release();
        throw error;
      }
    };
    try { assertCurrent(); }
    catch (error) { release(); throw error; }
    return Object.freeze({ extensionId, sessionId, pageId, epoch, sourceId, signal: lifetime.signal, assertCurrent, release });
  }

  closePage(pageId: number): void {
    for (const access of this.active) if (access.pageId === pageId) access.release();
  }
}
