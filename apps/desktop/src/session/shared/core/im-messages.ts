import type { MessageItem } from '@gugu/core/shared/types/chat'

/** Facts already read by the chat projection or the shared topic list; never display-list differences. */
export interface ImChatAccess {
  chatId: string
  /** Existing account/projection cursor captured when the authoritative read began. */
  revision?: string
  sourceChatId?: string | null
  ownMember?: boolean
  membershipRevoked?: boolean
  archived?: boolean
}

export type ImMessageWrite =
  /** claimed: set by the store on the put of the revision that first delivered this message (its notification claim). */
  | { type: 'put'; message: MessageItem; claimed?: true }
  | { type: 'delete'; chatId: string; id: string }
  | { type: 'deleteChat'; chatId: string }
  | { type: 'chatAccess'; access: ImChatAccess }
  | { type: 'truncateRange'; chatId: string }

export interface ImMessageRange {
  chatId: string
  threadRootId?: string | null
  fromSeq: number
  toSeq: number
}

export interface ImMessageBatch {
  writes: ImMessageWrite[]
  /** Parsed directly from the server's revision page, in revision order. */
  revisions: { revision: string; writes: ImMessageWrite[] }[]
  throughRevision?: string
  ranges?: ImMessageRange[]
}

export interface ImMessagePage {
  chatId?: string
  /** Bounded canonical-row reads for server overlay patches, never rows from the view cache. */
  ids?: string[]
  threadRootId?: string | null
  beforeSeq?: number
  afterSeq?: number
  limit: number
}

export interface ImMessagePageResult {
  rows: MessageItem[]
  /** An incomplete range must be read from the network, even when older local rows exist. */
  covered: boolean
}

/** The local host owns these rows even when the workbench is connected to another machine. */
export interface MessageStore {
  ingest(accountId: string, batch: ImMessageBatch): Promise<ImMessageWrite[]>
  windows(accountId: string, chatIds: string[], limit: number): Promise<MessageItem[]>
  page(accountId: string, page: ImMessagePage): Promise<ImMessagePageResult>
  throughRevision(accountId: string): Promise<string | null>
  clearAccount(accountId: string): Promise<void>
  search(accountId: string, chatId: string, query: string, limit: number, fromUserId?: string): Promise<MessageItem[]>
}
