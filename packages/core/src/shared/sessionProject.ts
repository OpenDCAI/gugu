/** Stable identity of the app-owned workspace backing tasks without a selected project. */
export const IMPLICIT_SESSION_HOME_PROJECT_ID = '00000000-0000-4000-8000-000000000001'

export function isImplicitSessionHomeProjectId(projectId: string | null | undefined): boolean {
  return projectId === IMPLICIT_SESSION_HOME_PROJECT_ID
}
