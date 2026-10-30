/** Shared local-project visibility predicate. The expression comes from static query code, never user input. */
export function localProjectsOnly(projectId: string): string {
  return `NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = ${projectId} AND p.workspace_provider != 'local')`;
}
