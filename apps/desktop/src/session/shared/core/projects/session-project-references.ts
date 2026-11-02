export type SessionProjectLocation = { conversationId: string; projectId: string };

/** A session keeps its identity when its project changes; saved project IDs are only location hints. */
export function alignSessionProjectReferences<T>(snapshot: T, locations: readonly SessionProjectLocation[]): T {
  const projects = new Map(locations.map(row => [row.conversationId, row.projectId]));
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const next = value.map(visit);
      return next.some((item, index) => item !== value[index]) ? next : value;
    }
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const next = Object.fromEntries(Object.entries(record).map(([key, item]) => [key, visit(item)]));
    const project = typeof record.sessionId === 'string' ? projects.get(record.sessionId) : undefined;
    if (project && typeof record.projectId === 'string') next.projectId = project;
    return Object.keys(next).some(key => next[key] !== record[key]) ? next : value;
  };
  return visit(snapshot) as T;
}
