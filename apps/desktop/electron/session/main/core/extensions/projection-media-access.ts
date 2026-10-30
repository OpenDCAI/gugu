import type { BridgeCaller } from './extension-bridge';
import type { ExtensionProjections } from './extension-projections';

type Access = { pageId: number | string; release(): void };
type Binding = Readonly<{
  extensionId: string; sessionId: string; pageId: number | string; epoch: number | string;
  signal?: AbortSignal; assertCurrent(): void;
}>;
/** Constructed by the authenticated host handler, never deserialized as a grant. */
export type ProjectionRemoteMediaBinding = Binding & Readonly<{ pageId: string; epoch: string; signal: AbortSignal }>;

/** Main-process authority for media. A payload's session id is never a lease. */
export class ProjectionMediaAccess {
  private readonly active = new Set<Access>();

  constructor(private readonly resources: ExtensionProjections, private readonly epochOf: (pageId: number) => number) {}

  open(caller: BridgeCaller, sourceId: string) {
    if (caller.kind !== 'page' || !caller.binding?.sessionId) throw new Error('Projection media needs a bound task page');
    const { extensionId, pageId } = caller, sessionId = caller.binding.sessionId, epoch = this.epochOf(pageId);
    return this.openBinding({ extensionId, sessionId, pageId, epoch, assertCurrent: () => {
      if (caller.kind !== 'page' || caller.extensionId !== extensionId || caller.pageId !== pageId
        || caller.binding?.sessionId !== sessionId || this.epochOf(pageId) !== epoch) {
        throw new Error('Projection media page binding changed');
      }
    } }, sourceId);
  }

  openRemote(binding: ProjectionRemoteMediaBinding, sourceId: string) {
    return this.openBinding(binding, sourceId);
  }

  private openBinding(binding: Binding, sourceId: string) {
    binding.signal?.throwIfAborted(); binding.assertCurrent();
    const { extensionId, sessionId, pageId, epoch } = binding;
    if (this.active.size >= 64 || [...this.active].filter(access => access.pageId === pageId).length >= 16) {
      throw new Error('Too many projection media bindings');
    }
    const source = this.resources.sourceAccess({ extensionId, sessionId }, sourceId);
    const lifetime = new AbortController();
    const release = () => {
      source.signal.removeEventListener('abort', revokeSource); binding.signal?.removeEventListener('abort', revokeBinding);
      this.active.delete(access);
      lifetime.abort(new Error('Projection media authority released'));
    };
    const revokeSource = () => { lifetime.abort(source.signal.reason); release(); };
    const revokeBinding = () => { lifetime.abort(binding.signal!.reason); release(); };
    const access = { pageId, release };
    this.active.add(access);
    source.signal.addEventListener('abort', revokeSource, { once: true });
    binding.signal?.addEventListener('abort', revokeBinding, { once: true });
    if (source.signal.aborted) revokeSource();
    if (binding.signal?.aborted) revokeBinding();
    const assertCurrent = () => {
      try {
        lifetime.signal.throwIfAborted(); binding.signal?.throwIfAborted(); binding.assertCurrent(); source.assertCurrent();
        if (binding.extensionId !== extensionId || binding.sessionId !== sessionId || binding.pageId !== pageId || binding.epoch !== epoch) {
          throw new Error('Projection media page binding changed');
        }
      } catch (error) { lifetime.abort(error); release(); throw error; }
    };
    try { assertCurrent(); }
    catch (error) { release(); throw error; }
    return Object.freeze({ extensionId, sessionId, pageId, epoch, sourceId, signal: lifetime.signal, assertCurrent, release });
  }

  closePage(pageId: number): void {
    for (const access of this.active) if (access.pageId === pageId) access.release();
  }
}
