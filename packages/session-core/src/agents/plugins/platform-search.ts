import type { PlatformCallableRoutes } from './capabilities/session-bundle';

export const PLATFORM_STANDALONE_SEARCH_ROUTE = '/v1/alpha/search';

/** Search is granted for this model, not merely for some model on the token. */
export function platformStandaloneSearchGranted(
  routes: PlatformCallableRoutes | undefined,
  model: string | null | undefined,
): boolean {
  return Boolean(model?.trim() && routes?.[PLATFORM_STANDALONE_SEARCH_ROUTE]?.includes(model.trim()));
}
