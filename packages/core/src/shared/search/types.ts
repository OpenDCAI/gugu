/** Portable search data. Storage IDs are bare; tool-boundary IDs use typedId.mjs. */
export interface SearchQuery {
  text: string
  filters: {
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

/** Supplied by the authenticated host binding, never by a model or a search modifier. */
export interface SearchActor {
  accountId: string
  actorId: string
}

/** null is an unrestricted, known membership floor; unknown is not membership. */
export type SearchHistoryFloor = { known: true; at: string | null } | { known: false }

export interface SearchActorScope {
  actorId: string
  chatId: string
  floor: SearchHistoryFloor
}

/** One stored body shared by the account's actors; no actor's authorization is inferred from it. */
export interface SearchDocument {
  id: string
  chatId: string
  threadRootId: string | null
  seq: number
  senderId: string | null
  createdAt: string
  text: string
  isWhisper: boolean
  toUserIds: string[]
  deletedAt: string | null
  hasFile: boolean
  hasImage: boolean
  hasLink: boolean
}

/** Actor-specific proof, kept separately from the shared body. */
export interface SearchDocumentAccess {
  actorId: string
  messageId: string
  /** A page returned by message_history_as for this exact actor. */
  fromHistory: boolean
  /** Unknown on an older history response; unknown must not become false. */
  hiddenForActor: boolean | null
}

/** A server-confirmed interval within one stream. Missing sequence numbers are not holes. */
export interface SearchCoverageRange {
  threadRootId: string | null
  oldestSeq: number
  newestSeq: number
}

export type SearchCoverageReason = 'history-incomplete' | 'visibility-unverified' | 'threads-unverified'
  | 'cleared' | 'stale'

export interface SearchCoverage {
  actorId: string
  chatId: string
  ranges: SearchCoverageRange[]
  oldestAt: string | null
  newestAt: string | null
  /** Requires exhausted streams, verified actor visibility and no incomplete reason. */
  complete: boolean
  reasons: SearchCoverageReason[]
}

export interface SearchCoverageReport {
  source: 'local'
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
  createdAt: string
  text: string
  highlights: SearchHighlight[]
  rank: SearchRank
}

export interface SearchResults {
  results: SearchMessageHit[]
  coverage: SearchCoverageReport
  nextCursor: string | null
}

/** One actor's confirmed page. The driver commits rows, access and coverage in ONE transaction. */
export interface SearchHistoryPage {
  actorId: string
  chatId: string
  threadRootId: string | null
  documents: SearchDocument[]
  access: SearchDocumentAccess[]
  coverage: SearchCoverage
}

/** Driver-independent backfill boundary. Runtime queries/IPC belong to the host search controller. */
export interface SearchStore {
  commitPage(page: SearchHistoryPage): Promise<void>
  coverage(actorId: string, chatIds?: readonly string[]): Promise<SearchCoverage[]>
}
