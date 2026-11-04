type Resource = { layout(): void; close(): void };
const pages = new Map<number, Set<Resource>>();

/** Native resources follow the host's document binding, rather than App-reported task IDs. */
export function ownAppPageResource(pageId: number, resource: Resource): () => void {
  const batch = pages.get(pageId) ?? new Set<Resource>(); batch.add(resource); pages.set(pageId, batch);
  return () => { batch.delete(resource); if (!batch.size && pages.get(pageId) === batch) pages.delete(pageId); };
}
export function layoutAppPageResources(pageId: number): void {
  for (const resource of pages.get(pageId) ?? []) resource.layout();
}
export function closeAppPageResources(pageId: number): void {
  const batch = pages.get(pageId); pages.delete(pageId);
  const failures: unknown[] = [];
  for (const resource of batch ?? []) try { resource.close(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'App page resources did not close cleanly');
}
