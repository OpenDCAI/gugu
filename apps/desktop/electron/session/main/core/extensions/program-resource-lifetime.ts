type Release = () => void | Promise<void>;
const owned = new Map<number, Set<Release>>();
export function programResourceCount(pageId: number): number { return owned.get(pageId)?.size ?? 0; }

/** A program's host resources, admitted before any asynchronous acquisition. */
export function ownProgramResource(pageId: number, close: Release): () => void {
  const resources = owned.get(pageId) ?? new Set<Release>();
  resources.add(close);
  owned.set(pageId, resources);
  return () => {
    resources.delete(close);
    if (!resources.size && owned.get(pageId) === resources) owned.delete(pageId);
  };
}

/** Fence the captured generation synchronously; wait for every cleanup, including failures. */
export async function closeProgramResources(pageId: number): Promise<void> {
  const resources = owned.get(pageId);
  owned.delete(pageId);
  const closing: Promise<void>[] = [];
  for (const close of resources ?? []) {
    try { closing.push(Promise.resolve(close())); }
    catch (error) { closing.push(Promise.reject(error)); }
  }
  const results = await Promise.allSettled(closing);
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, 'App program resources did not close cleanly');
}
