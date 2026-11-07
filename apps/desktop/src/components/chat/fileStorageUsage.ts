import { QueryClient, queryOptions, type QueryFunctionContext } from '@tanstack/react-query'
import { rendererLogger } from '../../lib/log'
import { chatDb } from '../../lib/supabase'

type Usage = { used_and_reserved_bytes: number; limit_bytes: number; warning: boolean; full: boolean }
type UsageKey = readonly ['file-storage-usage', string, string]
const log = rendererLogger('files/storage-usage')

// Mounted only by storage observers: resuming a paused read must not refetch unrelated attachment queries.
export const fileStorageUsageClient = new QueryClient()

// The cache keeps a module-level reader and plain key inputs, never a composer's render closure.
async function readUsage({ queryKey: [, userId, chatId] }: QueryFunctionContext<UsageKey>): Promise<Usage> {
  try {
    const { data, error } = await chatDb.rpc('file_transfer_group_usage', { p_chat: chatId, p_as: userId })
    if (error) throw new Error(error.message, { cause: error })
    const row = data as Usage | null
    if (!row || !Number.isSafeInteger(row.used_and_reserved_bytes) || row.used_and_reserved_bytes < 0 ||
      !Number.isSafeInteger(row.limit_bytes) || row.limit_bytes < 0 || typeof row.warning !== 'boolean' || typeof row.full !== 'boolean') {
      throw new Error('Invalid group file usage response')
    }
    return row
  } catch (error) {
    log.error({ userId, chatId, error: String(error), cause: error instanceof Error ? error.cause : undefined }, 'could not read group file storage usage')
    throw error
  }
}

/** One entry per account/group: attachment changes retain the last verified usage. */
export function fileStorageUsageQuery(userId: string, chatId: string) {
  return queryOptions({ queryKey: ['file-storage-usage', userId, chatId] as const, queryFn: readUsage })
}
