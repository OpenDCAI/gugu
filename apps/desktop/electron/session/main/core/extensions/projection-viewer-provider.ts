/** Installed by the authenticated outer host; no device ID, proof, or key comes from an App. */
export interface ProjectionViewerClient {
  signal: AbortSignal;
  open(sourceId: string): Promise<{ id: string; offer: { type: 'offer'; sdp: string } }>;
  answer(id: string, sdp: { type: 'answer'; sdp: string }): Promise<void>;
  sign(id: string, data: string): string;
  close(): Promise<void>;
}
let open: ((pageId: number) => Promise<ProjectionViewerClient>) | undefined;
export function setProjectionViewerOpener(provider: ((pageId: number) => Promise<ProjectionViewerClient>) | undefined): void { open = provider; }
export function openProjectionViewer(pageId: number): Promise<ProjectionViewerClient> {
  if (!open) throw new Error('This host has no authenticated projection viewer');
  return open(pageId);
}
