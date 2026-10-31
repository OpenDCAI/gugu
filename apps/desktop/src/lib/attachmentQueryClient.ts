import { QueryClient } from '@tanstack/react-query'

// Chat and topic cards also render outside the task renderer's QueryClientProvider.
export const attachmentQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
