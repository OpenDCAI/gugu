import { randomUUID } from 'node:crypto';
import { workspaceSession } from '@shared/extensions/app-runtime-protocol';
import type { BridgeCaller } from './extension-bridge';
import { ownAppPageResource } from './app-page-resources';
import type { ProjectionViewerClient } from './projection-viewer-provider';

type Viewer = { id: string; caller: BridgeCaller; live: boolean; client?: ProjectionViewerClient; stream?: string; release(): void };
/** A page-bound facade over existing authenticated signaling. Secrets stay in main. */
export class ExtensionProjectionViewers {
  private readonly viewers = new Map<string, Viewer>();
  constructor(private readonly authorize: (extensionId: string) => void,
    private readonly open: (pageId: number) => Promise<ProjectionViewerClient>, private readonly report: (error: unknown) => void) {}
  private page(caller: BridgeCaller): void {
    if (caller.kind !== 'page' || !workspaceSession(caller.binding)) throw new Error('Projection media needs a bound task App page');
    this.authorize(caller.extensionId);
  }
  private own(caller: BridgeCaller, id: unknown): Viewer {
    this.page(caller);
    const viewer = typeof id === 'string' ? this.viewers.get(id) : undefined;
    if (!viewer || !viewer.live || viewer.caller.pageId !== caller.pageId || viewer.caller.extensionId !== caller.extensionId
      || viewer.caller.binding !== caller.binding) throw new Error('This projection viewer is not owned by this App page');
    return viewer;
  }
  async acquire(caller: BridgeCaller, sourceId: unknown) {
    this.page(caller);
    if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 256) throw new Error('Invalid projection source');
    if ([...this.viewers.values()].filter(viewer => viewer.caller.pageId === caller.pageId).length >= 16) throw new Error('Too many projection viewers');
    const viewer: Viewer = { id: randomUUID(), caller, live: true, release: () => {} };
    this.viewers.set(viewer.id, viewer);
    viewer.release = ownAppPageResource(caller.pageId, { layout: () => {}, close: () => {
      void this.close(viewer).catch(this.report);
    } });
    try {
      const client = await this.open(caller.pageId); viewer.client = client;
      if (!viewer.live) { await client.close(); throw new Error('Projection App page changed'); }
      const result = await client.open(sourceId);
      if (!viewer.live || client.signal.aborted) throw new Error('Projection App page changed');
      viewer.stream = result.id;
      return { id: viewer.id, offer: result.offer };
    } catch (error) { await this.close(viewer).catch(this.report); throw error; }
  }
  async answer(caller: BridgeCaller, args: Record<string, unknown>): Promise<void> {
    const viewer = this.own(caller, args.id), answer = args.answer as { type?: unknown; sdp?: unknown } | undefined;
    if (!answer || answer.type !== 'answer' || typeof answer.sdp !== 'string' || answer.sdp.length > 128 * 1024) throw new Error('Invalid projection answer');
    await viewer.client!.answer(viewer.stream!, answer as { type: 'answer'; sdp: string });
    this.own(caller, args.id);
  }
  sign(caller: BridgeCaller, args: Record<string, unknown>): string {
    const viewer = this.own(caller, args.id);
    if (typeof args.data !== 'string' || Buffer.byteLength(args.data) > 16 * 1024) throw new Error('Invalid projection control');
    return viewer.client!.sign(viewer.stream!, args.data);
  }
  release(caller: BridgeCaller, id: unknown): Promise<void> { return this.close(this.own(caller, id)); }
  private async close(viewer: Viewer): Promise<void> {
    if (!viewer.live) return;
    viewer.live = false; this.viewers.delete(viewer.id); viewer.release();
    await viewer.client?.close();
  }
}
