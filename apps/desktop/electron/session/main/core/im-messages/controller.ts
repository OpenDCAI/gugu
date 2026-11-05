import { createRPCController } from '@shared/lib/ipc/rpc'
import type { ImMessageBatch, ImMessagePage } from '@shared/core/im-messages'
import { sqlite } from '@main/db/client'
import { createImMessageStore } from './store'

let store: ReturnType<typeof createImMessageStore> | undefined
const localStore = () => store ??= createImMessageStore(sqlite)

export const imMessagesController = createRPCController({
  ingest: (accountId: string, batch: ImMessageBatch) => localStore().ingest(accountId, batch),
  windows: (accountId: string, chatIds: string[], limit: number) => localStore().windows(accountId, chatIds, limit),
  page: (accountId: string, options: ImMessagePage) => localStore().page(accountId, options),
  throughRevision: (accountId: string) => localStore().throughRevision(accountId),
  clearAccount: (accountId: string) => localStore().clearAccount(accountId),
  search: (accountId: string, chatId: string, query: string, limit: number, fromUserId?: string) =>
    localStore().search(accountId, chatId, query, limit, fromUserId),
})
