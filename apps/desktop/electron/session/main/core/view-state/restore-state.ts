import { sessionProjectLocations } from '../session-timeline/session-project-locations';
import { viewStateService } from './view-state-service';

/** Keep layout repair in the existing state read, without another startup IPC round trip. */
export async function readViewStateForRestore(sessionIds: string[]) {
  return { views: await viewStateService.getAll(), locations: sessionProjectLocations(sessionIds) };
}
