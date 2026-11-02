import { alignSessionProjectReferences, type SessionProjectLocation } from '@shared/core/projects/session-project-references';
import { appState } from '@renderer/lib/stores/app-state';
import { screenLayout } from '@renderer/app/screen-layout';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import type { NavigationSnapshot } from '@shared/view-state';

function alignSavedScreen(locations: readonly SessionProjectLocation[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const key = 'gugu.screen-layout.v1', raw = localStorage.getItem(key);
    if (!raw) return;
    const prior: unknown = JSON.parse(raw), next = alignSessionProjectReferences(prior, locations);
    if (next !== prior) localStorage.setItem(key, JSON.stringify(next));
  } catch (error) {
    log.warn('Could not update saved session locations', { error });
  }
}

/** Before restoring guards/layouts, align local snapshots with the host's actual session rows. */
export function prepareSessionProjectRestore(
  navigation: NavigationSnapshot | null, views: Record<string, unknown>, locations: readonly SessionProjectLocation[],
) {
  alignSavedScreen(locations);
  const next = alignSessionProjectReferences(navigation, locations);
  if (next && next !== navigation) void rpc.viewState.save('navigation', next).catch(error =>
    log.warn('Could not save the restored session location', { error }));
  return { navigation: next, views: alignSessionProjectReferences(views, locations) };
}

/** A remote directory changed: update references before the old project is removed and guards revalidate. */
export function reconcileSessionProjectLocations(locations: readonly SessionProjectLocation[]): void {
  if (!locations.length) return;
  const current = appState.navigation.viewParamsStore.session;
  const next = alignSessionProjectReferences(current, locations);
  if (next && next !== current) appState.navigation.updateViewParams('session', next);
  const screen = screenLayout.snapshot, aligned = alignSessionProjectReferences(screen, locations);
  if (aligned && aligned !== screen) screenLayout.restore(aligned);
  alignSavedScreen(locations);
}
