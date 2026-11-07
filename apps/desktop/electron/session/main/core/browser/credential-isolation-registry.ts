import type { WebContents } from 'electron';

export type PrivateCredentialSurface = Readonly<{
  loginSurfaceId: string; loginSurfaceEpoch: string; browserId: string; partition: string; contents: WebContents;
}>;
type PartitionRestriction = { allowsPublication(contents: WebContents): boolean };
const privateContents = new WeakSet<WebContents>();
const candidates = new WeakSet<WebContents>();
const surfaces = new Map<string, PrivateCredentialSurface>();
const sessions = new Map<object, PartitionRestriction>();
const partitions = new Map<string, PartitionRestriction>();

/** Fixed native host hook for B-2. Never register this contents in the Agent browser registry. */
export function registerPrivateCredentialSurface(input: PrivateCredentialSurface): () => void {
  if (!input.loginSurfaceId || !input.loginSurfaceEpoch || !input.browserId || !input.partition
    || input.contents.isDestroyed() || input.contents.debugger.isAttached() || surfaces.has(input.loginSurfaceId)
    || privateContents.has(input.contents)) throw new Error('credential_private_surface_unavailable');
  const surface = Object.freeze({ loginSurfaceId: input.loginSurfaceId, loginSurfaceEpoch: input.loginSurfaceEpoch,
    browserId: input.browserId, partition: input.partition, contents: input.contents });
  privateContents.add(input.contents);
  surfaces.set(input.loginSurfaceId, surface);
  return () => {
    // A caller cannot unmark a live private page, nor reuse a retired page as an Agent page.
    if (!surface.contents.isDestroyed()) throw new Error('credential_private_surface_not_retired');
    if (surfaces.get(surface.loginSurfaceId) === surface) surfaces.delete(surface.loginSurfaceId);
  };
}

/** Native host identity lookup; a string alone never supplies a contents or capability to a tool. */
export function privateCredentialSurface(id: string, epoch: string): PrivateCredentialSurface {
  const surface = surfaces.get(id);
  if (!surface || surface.loginSurfaceEpoch !== epoch) throw new Error('credential_private_surface_unavailable');
  return surface;
}

export function credentialAgentPartitionBlocked(partition: string): boolean { return partitions.has(partition); }

export function assertCredentialAgentContents(contents: WebContents): void {
  if (privateContents.has(contents) || candidates.has(contents)) throw new Error('credential_private_page_unavailable');
  if (contents.isDestroyed()) throw new Error('the browser tab was closed');
  const restriction = sessions.get(contents.session);
  if (restriction) throw new Error('credential_partition_isolated');
}

/** Only native registry adoption uses this exception; it never opens an Agent connection. */
export function assertCredentialNativeAdoption(contents: WebContents): void {
  if (privateContents.has(contents) || contents.isDestroyed()) throw new Error('credential_private_page_unavailable');
  const restriction = sessions.get(contents.session);
  if (candidates.has(contents) && restriction?.allowsPublication(contents)) return;
  assertCredentialAgentContents(contents);
}

/** Internal isolation lifecycle hooks. These neither approve a use nor resume an old observer. */
export function restrictCredentialPartition(partition: string, nativeSession: object, restriction: PartitionRestriction): () => void {
  if (partitions.has(partition) || sessions.has(nativeSession)) throw new Error('credential_partition_busy');
  partitions.set(partition, restriction); sessions.set(nativeSession, restriction);
  return () => {
    if (partitions.get(partition) === restriction) partitions.delete(partition);
    if (sessions.get(nativeSession) === restriction) sessions.delete(nativeSession);
  };
}

export function markCredentialHandoffCandidate(contents: WebContents): void { candidates.add(contents); }
export function publishCredentialHandoffCandidate(contents: WebContents): void { candidates.delete(contents); }
