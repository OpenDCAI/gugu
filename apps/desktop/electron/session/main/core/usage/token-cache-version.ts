/** Parser upgrades refresh the same eight local days as the normal usage sync. */
export const TOKEN_CACHE_VERSION = 2;

export function recentTokenRefreshFrom(now = Date.now()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 7);
  return start.getTime();
}
