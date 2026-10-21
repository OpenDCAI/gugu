import { QueryClient } from '@tanstack/react-query'

/**
 * Discover data is public product content, but it can change while the app stays open.
 * Keep a feature-scoped cache so tab navigation does not throw away the last good snapshot;
 * stale queries revalidate when the pane becomes active or the window regains focus.
 */
export const discoverQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 300_000,
      gcTime: 30 * 60_000,
      retry: false,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  },
})
