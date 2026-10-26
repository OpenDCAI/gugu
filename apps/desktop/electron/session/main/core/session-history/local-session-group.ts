import { isImplicitSessionHomeProjectId } from '@shared/core/projects/session-home-project';
import { SESSION_HOME_SECTION_KEY, isSessionHomeDirectory } from '@shared/core/session-history/session-history';
import { findRepoRoot } from './repo-root';

export type LocalSessionGroup = { key: string | null; label: string | null };
type SessionProject = { projectId: string; projectPath: string; projectName: string };

/** The history list and Apps group native transcripts by the same registered projects and repository boundaries. */
export function createLocalGroupOf(projects: SessionProject[]): (directory: string | null) => LocalSessionGroup {
  const projectPaths = [...new Map(projects.map((project) => [project.projectPath, project])).values()]
    .filter((project) => !isImplicitSessionHomeProjectId(project.projectId))
    .map((project) => ({ key: project.projectPath, label: project.projectName }))
    .sort((a, b) => b.key.length - a.key.length);
  const isAtOrUnder = (path: string, base: string) =>
    path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
  return (directory) => {
    if (!directory) return { key: null, label: null };
    if (isSessionHomeDirectory(directory)) return { key: SESSION_HOME_SECTION_KEY, label: null };
    const boundary = findRepoRoot(directory) ?? directory;
    return projectPaths.find((project) => isAtOrUnder(directory, project.key) && isAtOrUnder(project.key, boundary))
      ?? { key: boundary, label: null };
  };
}
