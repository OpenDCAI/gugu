import { alignSessionProjectReferences, referencedSessionIds, type SessionProjectLocation } from '@shared/core/projects/session-project-references';
import { appState } from '@renderer/lib/stores/app-state';
import { screenLayout } from '@renderer/app/screen-layout';
import { log } from '@renderer/utils/logger';

/** The host repairs its view-state KV during migration; only saved renderer references need querying. */
export function savedScreenSessionIds(): string[] {
  let screen: unknown = null;
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem('gugu.screen-layout.v1');
    if (raw) screen = JSON.parse(raw);
  } catch (error) {
    log.warn('Could not read saved session locations', { error });
  }
  return referencedSessionIds(screen);
}

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

/** The host already repaired navigation/view-state KV; the renderer owns only its saved screen. */
export function restoreSavedScreenSessionLocations(locations: readonly SessionProjectLocation[]): void {
  alignSavedScreen(locations);
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
