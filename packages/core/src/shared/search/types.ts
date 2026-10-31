import type { RawMessageRow } from '../../cloud/messageItem'

/** Portable search data. Storage IDs are bare; tool-boundary IDs use typedId.mjs. */
export interface SearchQuery {
  text: string
  filters: {
    kind?: 'message' | 'task'
    in?: { kind: 'chat' | 'topic' | 'session'; id: string; includeTopics?: boolean }[]
    from?: string[]
    has?: ('file' | 'image' | 'link')[]
    is?: ('mention' | 'whisper')[]
    /** ISO calendar dates (YYYY-MM-DD), interpreted in the device's local time zone. */
    before?: string
    after?: string
    on?: string
  }
  sort: 'recent' | 'relevant'
  /** Navigation only. Never restricts a query or grants access. */
  origin?: { chatId: string }
}

/**
 * One indexed message. Rows come only from the signed-in account's own message reads, which the
 * server already filtered by its visibility rule; the index stores that result and never re-decides it.
 */
export interface SearchDocument {
  id: string
  chatId: string
  threadRootId: string | null
  seq: number
  senderId: string | null
  createdAt: string
  text: string
  /** Filter inputs only (is:mention, is:whisper), not access decisions. */
  toUserIds: string[]
  isWhisper: boolean
  hasFile: boolean
  hasImage: boolean
  hasLink: boolean
}

export interface SearchChat {
  id: string
  kind: 'dm' | 'group' | 'ai' | 'topic'
  sourceChatId: string | null
}

/** Backfill progress of one stream (the main timeline, or one thread). */
export interface SearchCoverage {
  chatId: string
  threadRootId: string | null
  oldestSeq: number | null
  newestSeq: number | null
  /** The oldest page came back empty: everything older than oldestSeq has been read. */
  exhausted: boolean
}

export interface SearchTask {
  id: string
  title: string
  projectId: string
  agentUserId?: string | null
  /** Presentation only; terminal and ACP tasks use the same visible-message index. */
  terminal?: boolean
  archived?: boolean
}

export interface SearchTaskDocument {
  id: string
  taskId: string
  reference: string
  seq: number
  role: 'user' | 'assistant'
  senderId?: string | null
  /** Original conversation clock; missing timestamps remain unknown. */
  createdAt: string | null
  text: string
}

export interface SearchTaskCoverage {
  taskId: string
  lastSeq: number
  exhausted: boolean
  reason?: 'active' | 'unavailable' | 'unsupported' | 'diverged'
}

export interface SearchCoverageReport {
  tasks?: SearchTaskCoverage[]
  /** Every listed chat's main timeline is exhausted. */
  complete: boolean
  chats: SearchCoverage[]
}

export interface SearchHighlight {
  /** UTF-16 offsets into the original, unsegmented string; end is exclusive. */
  start: number
  end: number
}

export interface SearchReason {
  /** A stable key for the caller's translation; not an authorization decision. */
  code: 'exact' | 'prefix' | 'contains' | 'pinyin' | 'phrase' | 'terms' | 'text-relevance'
    | 'recent' | 'mention' | 'from-self' | 'chat-affinity' | 'sender-affinity' | 'agent' | 'thread'
  points: number
}

export interface SearchRank {
  score: number
  reasons: SearchReason[]
}

/** Data returned by the core query; UI navigation and the MCP response adapt the same row. */
export interface SearchMessageHit {
  kind: 'message'
  id: string
  chatId: string
  threadRootId: string | null
  seq: number
  senderId: string | null
  createdAt: string | null
  text: string
  /** An attachment hit: text is the file name (and caption). */
  attachment: 'file' | 'image' | null
  highlights: SearchHighlight[]
  rank: SearchRank
}

export interface SearchTaskHit extends Omit<SearchMessageHit, 'kind' | 'chatId' | 'threadRootId' | 'attachment'> {
  kind: 'task'
  taskId: string
  projectId: string
  title: string
  reference: string
  role: 'user' | 'assistant'
  archived?: boolean
  attachment: null
}

export type SearchHit = SearchMessageHit | SearchTaskHit

/** Facet counts stop here; a count above it means "more than SEARCH_FACET_CAP". */
export const SEARCH_FACET_CAP = 1000

/** Counts for the filter row: each ignores the has: filter; otherChats counts matches outside in:. */
export interface SearchFacets {
  total: number
  file: number
  image: number
  link: number
  otherChats: number
  messages?: number
  tasks?: number
}

export interface SearchResults {
  results: SearchHit[]
  facets: SearchFacets
  coverage: SearchCoverageReport
  nextCursor: string | null
}

/** The only write vocabulary of a search index; a store applies one list in one transaction. */
export type SearchIndexOp =
  | { kind: 'rows'; rows: RawMessageRow[] }
  | { kind: 'remove'; ids: string[] }
  /** The authoritative chat list: chats absent from it are no longer readable and are purged. */
  | { kind: 'chats'; chats: SearchChat[] }
  | { kind: 'clearChat'; chatId: string }
  | { kind: 'coverage'; coverage: SearchCoverage }
  /** Local task inventory; it cannot remove chat messages. */
  | { kind: 'tasks'; tasks: SearchTask[] }
  | { kind: 'task'; task: SearchTask }
  | { kind: 'removeTask'; taskId: string }
  /** Replace a whole turn, including removal of items no longer visible after revision. */
  | { kind: 'taskTurn'; taskId: string; seq: number; documents: SearchTaskDocument[] }
  | { kind: 'truncateTask'; taskId: string; fromSeq: number }
  | { kind: 'taskCoverage'; coverage: SearchTaskCoverage }
