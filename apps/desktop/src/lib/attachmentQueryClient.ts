import { QueryClient, queryOptions, type QueryFunction, type QueryFunctionContext } from '@tanstack/react-query'

/**
 * @@@key-only-queries - chat and topic cards cache attachment reads here, outside the task renderer's QueryClientProvider,
 * for minutes after their bubble unmounts (default 5 min; thumbnails 30). A queryFn written in a component closes over that
 * render's whole scope (V8 keeps one context per function), so the cache used to keep every conversation that had shown an
 * attachment alive: its handlers, its old scroller, its unmounted message list (~600 nodes and ~400 listeners per opened
 * group on the owner's account). A query here is only its key: the client's one queryFn takes the inputs from the key and
 * calls a reader defined at module level. A query that brings its own queryFn is refused.
 */
type Reader = (args: readonly unknown[]) => Promise<unknown>
const readers = new Map<string, Reader>()

const readFromKey = ({ queryKey }: QueryFunctionContext) => {
  const [name, ...args] = queryKey
  const read = readers.get(String(name))
  if (!read) throw new Error(`No attachment query reader for ${String(name)}`)
  return read(args)
}

export const attachmentQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: readFromKey } } })
attachmentQueryClient.getQueryCache().subscribe((event) => {
  if (event.type === 'added' && event.query.options.queryFn !== readFromKey) {
    throw new Error(`Attachment query ${JSON.stringify(event.query.queryKey)} brings its own queryFn; define it with attachmentQuery()`)
  }
})

/**
 * Defines one kind of attachment query: `read` gets the key's arguments, so everything it needs must be in the key (plain
 * data). Returns the options builder components pass to useQuery / fetchQuery with this client; its queryFn is the client's
 * own, typed with this reader's result.
 */
export function attachmentQuery<Args extends unknown[], Result>(name: string, read: (...args: Args) => Promise<Result>) {
  // A module evaluated again (hot reload, a test's module reset) defines its query again: the latest reader serves.
  readers.set(name, (args) => read(...(args as Args)))
  return (...args: Args) => queryOptions({ queryKey: [name, ...args] as [string, ...Args], queryFn: readFromKey as unknown as QueryFunction<Result, [string, ...Args]> })
}
