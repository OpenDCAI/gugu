import type { ListenMode } from './chat'

// #2260 — renderer-facing types for the unified single/team agent provisioning saga. These mirror the
// durable rows + RPC returns of gugu-supabase's supabase/migrations/20260721130000_agent_provision_saga_2260.sql. The DB is
// authoritative for phases, hashes, template ids and bounded concurrency; the renderer only drives the RPCs
// and observes these shapes.

export type AgentProvisionKind = 'single' | 'team'

export type AgentProvisionOperationPhase =
  | 'provisioning_members'
  | 'completed'
  | 'failed'
  | 'cleaning_up'
  | 'cancelled'

export type AgentProvisionMemberPhase =
  | 'queued'
  | 'preparing'
  | 'awaiting_terminal'
  | 'ready'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled'

// Terminal operation phases — an operation in one of these is done and not resumable/claimable.
export const AGENT_PROVISION_TERMINAL_OPERATION_PHASES: readonly AgentProvisionOperationPhase[] = [
  'completed',
  'cancelled',
]

// A member canonical blueprint entry (allowlisted keys only — must match the migration's strict validation:
// single forbids listen_mode; team requires it). Optional fields are OMITTED when absent so the stored row's
// DB-derived hash (which NULLIFs empties) matches what prepare re-derives.
export type AgentMemorySource = 'claude-code' | 'codex'

export interface AgentProvisionBlueprintMember {
  provision_id: string
  member_key: string
  display_name: string
  agent_type: string
  project_path?: string
  avatar?: string
  special_focus?: string
  // #2260 REQUIRED explicit member intent (never DB-defaulted).
  inherit_memory: boolean
  history_import_required: boolean
  // optional cloud memory selection (raw content travels SEPARATELY, never in the blueprint/hash).
  memory_sources?: AgentMemorySource[]
  listen_mode?: ListenMode
  // #7199 搬家:接过一位已有的助理(复用它的身份与私聊,不发欢迎语、不跑初始化)。只许 kind='single',
  // 不能同时带 first_task / 首条消息 / memory_sources;库侧校验 agent 在调用者名下、类型与 agent_profiles 一致、
  // 不在目标设备上。cancel 在 ready 之前只撤这次搬家,❌ 不会去 remove_owned_agent 那个原有的助理。
  existing_agent_user_id?: string
  // server-derived; present ONLY in the STORED (normalized) blueprint, NEVER client-supplied.
  memory_content_hash?: string
}

export interface SingleAgentProvisionBlueprint {
  kind: 'single'
  concurrency_limit: 1
  members: [AgentProvisionBlueprintMember]
}

export interface TeamAgentProvisionBlueprint {
  kind: 'team'
  group_chat_id: string
  team_name: string
  group_prompt: string
  concurrency_limit: number
  members: AgentProvisionBlueprintMember[]
}

export type AgentProvisionBlueprint = SingleAgentProvisionBlueprint | TeamAgentProvisionBlueprint

// Durable operation row (identity.agent_provision_operations).
export interface AgentProvisionOperation {
  id: string
  owner_user_id: string
  device_id: string
  kind: AgentProvisionKind
  payload_hash: string
  blueprint: AgentProvisionBlueprint
  phase: AgentProvisionOperationPhase
  group_chat_id: string | null
  concurrency_limit: number
  error: string | null
  created_at: string
  updated_at: string
}

// Durable member row (identity.agent_provisions).
export interface AgentProvision {
  id: string
  owner_user_id: string
  operation_id: string
  member_key: string
  device_id: string
  display_name: string
  agent_type: string
  project_path: string | null
  avatar: string | null
  special_focus: string | null
  initial_message_text?: string | null
  initial_message_id?: string | null
  inherit_memory: boolean
  memory_sources: AgentMemorySource[] | null
  // memory_content is a write-side secret (raw inherited memory); the renderer never needs to read it back and
  // it is scrubbed server-side at terminal, so it is intentionally omitted from this read projection.
  history_import_required: boolean
  history_payload_hash: string | null
  history_thread_root_id: string | null
  payload_hash: string
  agent_user_id: string | null
  // #2260 durable provisioned-agent EVIDENCE (set once at the first prepare binding, never cleared). It survives
  // governed removal's ON DELETE SET NULL of agent_user_id, so `provisioned_agent_user_id non-null + agent_user_id
  // NULL` is the stable "this member's exact agent was reclaimed" state — cancel/settle only, never re-provisioned.
  provisioned_agent_user_id: string | null
  dm_chat_id: string | null
  create_command_id: string | null
  phase: AgentProvisionMemberPhase
  template_client_message_id: string | null
  error: string | null
  created_at: string
  updated_at: string
}

// complete_agent_provision RETURNS TABLE(message_id, client_message_id, already).
// 搬家(adopt)那一种不发欢迎语:两个 id 都是 NULL —— 别解引用。
export interface CompleteAgentProvisionResult {
  messageId: string | null
  clientMessageId: string | null
  already: boolean
}

// Renderer-supplied member intent (before ids are minted / blueprint is built). inheritMemory +
// historyImportRequired are REQUIRED (mirroring the DB's explicit-boolean contract). Raw cloud memory bytes
// and the history transcript travel SEPARATELY (see AgentMemoryContentInput / AgentHistoryImportInput) — never
// inside the blueprint member.
export interface AgentProvisionMemberInput {
  memberKey: string
  displayName: string
  agentType: string
  projectPath?: string
  avatar?: string
  specialFocus?: string
  inheritMemory: boolean
  historyImportRequired: boolean
  memorySources?: AgentMemorySource[]
  listenMode?: ListenMode
  /** #7199 搬家:接过这位已有的助理(见 AgentProvisionBlueprintMember.existing_agent_user_id)。 */
  existingAgentUserId?: string
}

// Raw cloud memory bytes for a member's selected sources — passed SEPARATELY to start (p_memory_content),
// stored transiently on the provision row, scrubbed at terminal. Keyed source → content string.
export type AgentMemoryContentInput = Partial<Record<AgentMemorySource, string>>

// The history transcript payload for import_agent_provision_history (turns + provenance labels).
export interface AgentHistoryImportInput {
  title?: string
  source?: string
  providerSessionId?: string
  turns: unknown[]
}

// #2260 durable resume record (v2): the FULL replay intent, persisted per-owner BEFORE the first RPC. It
// carries ids + device + the hashed blueprint (small) plus per-member CLIENT-ONLY source references +
// versioned digests to detect a changed local memory/transcript source on resume — it NEVER stores raw memory
// bytes or the turns array, and the SQL never trusts these digests.
export interface AgentProvisionMemorySourceRef {
  sources: AgentMemorySource[]
  // versioned client-only digest over the exact memory-content bytes used at create (for reread comparison).
  clientDigest: string
}
export interface AgentProvisionHistorySourceRef {
  filePath: string
  source: string
  sessionId?: string
  // versioned client-only digest over the exact constructed history payload bytes (reread comparison only).
  clientDigest: string
}

// The durable outcome of driving ONE member through prepare → wait → settle → complete.
//  - 'completed': template written (template result carried).
//  - 'failed':    the agent.create command errored; recoverable via same-agent retry.
//  - 'awaiting_terminal': the command is not yet terminal (e.g. slow handshake) — resumable, not an error.
export interface AgentProvisionMemberOutcome {
  member: AgentProvision
  template?: CompleteAgentProvisionResult
}
