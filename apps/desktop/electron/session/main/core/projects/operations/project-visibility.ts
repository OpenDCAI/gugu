import { events } from '@main/lib/events';
import { projectVisibilityChangedChannel } from '@shared/core/projects/projectEvents';
import { getProjects } from './getProjects';

/** Visibility is derived from real directory memberships and unarchived sessions, never filesystem probes. */
export async function publishProjectVisibility(projectId: string): Promise<void> {
  const project = (await getProjects()).find((candidate) => candidate.id === projectId) ?? null;
  events.emit(projectVisibilityChangedChannel, { projectId, project });
}
