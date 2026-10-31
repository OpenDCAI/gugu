import { permanentlyRemove } from '@gugu/core/cloud/agentIdentityRemoval'
import { identityDb, getCurrentAuthUserId } from './supabase'
import { chatService } from './chat'
import { listDevicesOnceIdentified } from './listDevicesOnceIdentified'
import { platform } from '../platform'
import { ensureSshMachineUsable } from './sshLinkChannel'
import type {
  AgentHistoryImportInput,
  AgentMemoryContentInput,
  AgentMemorySource,
  AgentProvisionHistorySourceRef,
  AgentProvisionMemorySourceRef,
  AgentProvision,
  AgentProvisionBlueprint,
  AgentProvisionBlueprintMember,
  AgentProvisionKind,
  AgentProvisionMemberInput,
  AgentProvisionMemberOutcome,
  AgentProvisionOperation,
  AgentProvisionOperationPhase,
  CompleteAgentProvisionResult,
  SingleAgentProvisionBlueprint,
  TeamAgentProvisionBlueprint,
} from '@gugu/core/shared/types/agentProvision'
import { AGENT_PROVISION_TERMINAL_OPERATION_PHASES } from '@gugu/core/shared/types/agentProvision'
import type { CreateAgentOnDeviceResult } from '@gugu/core/shared/types/chat'
import { refreshCloudComputer, wakeCloudComputer } from './cloudComputerStore'

// #2260 — shared single-member provision PRIMITIVE. Single-agent create and every team member ride ONE
// idempotent chain: start operation → DB-authoritative claim → prepare (server-side create agent+DM+command)
// → wait for the agent.create command's TRUE terminal → settle → complete (exactly-once template). The DB
// owns hashes, template ids and bounded concurrency; this module NEVER derives a canonical hash or template
// id, NEVER sends agent.deliver, and NEVER treats a command enqueue as completion. The team orchestration
// (recovery / repeated claim batches / retry / cancel / finalize) lives in teamProvisionSaga.ts.

const firstRow = <T>(data: unknown): T | null =>
  Array.isArray(data) ? ((data[0] as T) ?? null) : ((data as T) ?? null)

// ── RPC wrappers (fail-loud: throw on error.message, mirroring chat.ts/supabase.ts) ─────────────────────

/** 创建框里的选择(#6264):没选的项 = null,由目标机器退回默认。 */
export interface AgentCreateChoice {
  model?: string | null
  effort?: string | null
  permissionMode?: string | null
}

export async function startProvisionOperation(
  operationId: string,
  deviceId: string,
  blueprint: AgentProvisionBlueprint,
  memoryContent?: Record<string, AgentMemoryContentInput>,
  initialMessage?: { messageId: string; text: string },
  choice?: AgentCreateChoice,
): Promise<AgentProvisionOperation> {
  const { data, error } = await identityDb.rpc('start_agent_provision_operation', {
    p_operation_id: operationId,
    p_device_id: deviceId,
    p_blueprint: blueprint,
    // Raw cloud memory bytes travel SEPARATELY (never in the blueprint/hash); {member_key:{source:content}}.
    p_memory_content: memoryContent ?? null,
    // 库里的契约是 {text, client_message_id}(20260831110000_chat_initial_prompt_argv_4567.sql),多一个键都整条拒绝。
    // 之前原样传 {messageId, text},带首条消息的创建(Codex 这类从启动参数读首条的)恒报
    // 「initial message must contain non-empty text and client_message_id」(#6264 实测撞到)。
    p_initial_message: initialMessage ? { text: initialMessage.text, client_message_id: initialMessage.messageId } : null,
    // 创建框里选的模型 / 思考强度 / 权限模式(#6264,gugu-supabase 20260924050100_agent_create_model_choice_6264.sql):
    // 记在成员行上、准备时写进 agent.create 命令,由目标机器解释。没选 = null。
    // 键名要能被 release-contract-gate 静态读出,❌ 条件展开。
    p_model: choice?.model ?? null,
    p_effort: choice?.effort ?? null,
    p_permission_mode: choice?.permissionMode ?? null,
  })
  if (error) throw new Error(error.message)
  const op = firstRow<AgentProvisionOperation>(data)
  if (!op) throw new Error('start_agent_provision_operation returned no operation')
  return op
}

/**
 * #7199 建个人助理那一次:比普通新建多带两样(gugu-supabase 20261015165000_agent_create_child_harness_first_task_7199.sql)——
 * 它开子 agent 不指定 harness 时用哪个(child_harness)、建好后系统交给它的第一件事(first_task,与首条消息互斥)。
 * 单开一个函数、❌ 并进 startProvisionOperation:那两个参数只有装了这条迁移的库才认,普通「新建 agent」不能因此在没装的库上整条失败。
 * 云上那一位由管家带同样两样建(管家 policy.assistantStartArgs),文案同出 @gugu/core/shared/assistantPolicy。
 */
export async function startAssistantProvisionOperation(
  operationId: string,
  deviceId: string,
  blueprint: AgentProvisionBlueprint,
  choice: AgentCreateChoice,
  assistant: AssistantStartExtras,
): Promise<AgentProvisionOperation> {
  const { data, error } = await identityDb.rpc('start_agent_provision_operation', {
    p_operation_id: operationId,
    p_device_id: deviceId,
    p_blueprint: blueprint,
    p_memory_content: null,
    p_initial_message: null,
    p_model: choice.model ?? null,
    p_effort: choice.effort ?? null,
    p_permission_mode: choice.permissionMode ?? null,
    p_child_harness: assistant.childHarness,
    p_first_task: assistant.firstTask,
  })
  if (error) throw new Error(error.message)
  const op = firstRow<AgentProvisionOperation>(data)
  if (!op) throw new Error('start_agent_provision_operation returned no operation')
  return op
}

/** 建个人助理时多带的那两样(见 startAssistantProvisionOperation)。 */
export interface AssistantStartExtras {
  childHarness: string
  firstTask: string
}

// Provision-owned IDEMPOTENT history import (wraps the non-idempotent base importer server-side). Returns the
// durable thread root; same payload replays to the same root, a divergent payload fails loud. Must land before
// complete when the member declared history_import_required.
export async function importAgentProvisionHistory(
  provisionId: string,
  payload: AgentHistoryImportInput,
): Promise<string> {
  const { data, error } = await identityDb.rpc('import_agent_provision_history', {
    p_provision_id: provisionId,
    p_payload: {
      title: payload.title ?? null,
      source: payload.source ?? null,
      session_id: payload.providerSessionId ?? null,
      turns: payload.turns,
    },
  })
  if (error) throw new Error(error.message)
  const root = firstRow<string>(data)
  if (!root) throw new Error(`import_agent_provision_history returned no thread root for ${provisionId}`)
  return root
}

// DB-authoritative bounded concurrency: the server moves at most (limit - inflight) queued members to
// 'preparing' under the operation-row lock and returns exactly those rows. There is NO renderer semaphore.
// claim is the SOLE capacity authority: it grants 'preparing' slots for BOTH queued first-creates AND explicit
// failed retries (retryProvisionIds), under the DB operation-row lock + concurrency budget. prepare rejects a
// direct 'queued'/'failed' row — so a failed-member retry MUST route through here, never straight to prepare.
export async function claimProvisionSlots(operationId: string, limit?: number, retryProvisionIds?: string[]): Promise<AgentProvision[]> {
  const { data, error } = await identityDb.rpc('claim_provision_slots', {
    p_operation_id: operationId,
    p_limit: limit ?? null,
    p_retry_provision_ids: retryProvisionIds && retryProvisionIds.length > 0 ? retryProvisionIds : null,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as AgentProvision[]
}

// prepare only ADVANCES a pre-existing member row (start_agent_provision_operation created every member).
// The params come straight off the claimed row, so the server-derived hash always matches the stored one.
export async function prepareClaimedMember(row: AgentProvision): Promise<AgentProvision> {
  const { data, error } = await identityDb.rpc('prepare_agent_provision', {
    p_provision_id: row.id,
    p_operation_id: row.operation_id,
    p_member_key: row.member_key,
    p_device_id: row.device_id,
    p_display_name: row.display_name,
    p_agent_type: row.agent_type,
    p_project_path: row.project_path,
    p_avatar: row.avatar,
    p_special_focus: row.special_focus,
    p_initial_message_id: row.initial_message_id,
    p_initial_message_text: row.initial_message_text,
  })
  if (error) throw new Error(error.message)
  const p = firstRow<AgentProvision>(data)
  if (!p) throw new Error(`prepare_agent_provision returned no row for ${row.id}`)
  return p
}

export async function settleProvisionTerminal(provisionId: string): Promise<AgentProvision> {
  const { data, error } = await identityDb.rpc('settle_agent_provision_terminal', {
    p_provision_id: provisionId,
  })
  if (error) throw new Error(error.message)
  const p = firstRow<AgentProvision>(data)
  if (!p) throw new Error(`settle_agent_provision_terminal returned no row for ${provisionId}`)
  return p
}

export async function completeProvision(provisionId: string): Promise<CompleteAgentProvisionResult> {
  const { data, error } = await identityDb.rpc('complete_agent_provision', {
    p_provision_id: provisionId,
  })
  if (error) throw new Error(error.message)
  const row = firstRow<{ message_id: string | null; client_message_id: string | null; already: boolean }>(data)
  if (!row) throw new Error(`complete_agent_provision returned no row for ${provisionId}`)
  return { messageId: row.message_id, clientMessageId: row.client_message_id, already: row.already }
}

// finalize_agent_team RETURNS chat.chats — the one group row for the whole team.
export async function finalizeAgentTeam(operationId: string): Promise<{ id: string } & Record<string, unknown>> {
  const { data, error } = await identityDb.rpc('finalize_agent_team', { p_operation_id: operationId })
  if (error) throw new Error(error.message)
  const group = firstRow<{ id: string } & Record<string, unknown>>(data)
  if (!group?.id) throw new Error('finalize_agent_team returned no group')
  return group
}

export async function cancelProvisionOperation(operationId: string): Promise<void> {
  const { error } = await identityDb.rpc('cancel_agent_provision_operation', { p_operation_id: operationId })
  if (error) throw new Error(error.message)
}

// settle_provision_cancellation advances members/operation to their terminal cancel phase ONLY from durable DB
// postconditions (identity absent AND governed tombstone AND no runtime AND no live command — see team-provision).
// It is the authority on convergence; the renderer never asserts "cancelled" on its own.
export async function settleProvisionCancellation(operationId: string): Promise<AgentProvisionOperation> {
  const { data, error } = await identityDb.rpc('settle_provision_cancellation', { p_operation_id: operationId })
  if (error) throw new Error(error.message)
  const op = firstRow<AgentProvisionOperation>(data)
  if (!op) throw new Error(`settle_provision_cancellation returned no operation for ${operationId}`)
  return op
}

// Courtesy stop before the governed reclaim: ask the runtime to go offline so the agent isn't mid-turn while its
// identity is removed. Injectable so cancel tests can drive stop/remove failures directly.
export async function defaultStopAgentRuntime(agentUserId: string): Promise<void> {
  const { error } = await identityDb.rpc('set_agent_desired_status', {
    p_agent_user_id: agentUserId,
    p_desired_status: 'offline',
  })
  if (error) throw new Error(error.message)
}

/** Explicit provision cancellation uses the same permanent identity removal as Delete Agent. */
export async function defaultRemoveOwnedAgent(agentUserId: string): Promise<void> {
  await permanentlyRemove({ client: identityDb, agentId: agentUserId })
}

// ── read / rediscovery helpers (owner-scoped by RLS SELECT) ─────────────────────────────────────────────

export async function getProvisionOperation(operationId: string): Promise<AgentProvisionOperation | null> {
  const { data, error } = await identityDb
    .from('agent_provision_operations')
    .select('*')
    .eq('id', operationId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as AgentProvisionOperation | null) ?? null
}

export async function getProvision(provisionId: string): Promise<AgentProvision | null> {
  const { data, error } = await identityDb
    .from('agent_provisions')
    .select('*')
    .eq('id', provisionId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as AgentProvision | null) ?? null
}

export async function listOperationMembers(operationId: string): Promise<AgentProvision[]> {
  const { data, error } = await identityDb
    .from('agent_provisions')
    .select('*')
    .eq('operation_id', operationId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as AgentProvision[]
}

// Rediscovery after a crash/reload: owner's non-terminal operations (RLS-scoped). 'failed' is included
// because a failed member is resumable via explicit same-agent retry.
const RESUMABLE_OPERATION_PHASES: AgentProvisionOperationPhase[] = [
  'provisioning_members',
  'failed',
  'cleaning_up',
]
export async function findResumableOperations(): Promise<AgentProvisionOperation[]> {
  const { data, error } = await identityDb
    .from('agent_provision_operations')
    .select('*')
    .in('phase', RESUMABLE_OPERATION_PHASES)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as AgentProvisionOperation[]
}

export function isTerminalOperationPhase(phase: AgentProvisionOperationPhase): boolean {
  return AGENT_PROVISION_TERMINAL_OPERATION_PHASES.includes(phase)
}

// ── command-terminal waiter (reuses the existing polling waiter; never treats enqueue as done) ──────────

// 'pending' = an EXISTING pending/running command (slow handshake) — resumable awaiting_terminal.
// 'missing' = no command row at all (e.g. a cancel race compare-and-deleted it) or an unrecognized status —
// this is NOT a slow handshake and must never be treated as pending/awaiting.
export type CommandTerminal = 'done' | 'error' | 'pending' | 'missing'

// Resolve to the create command's TRUE terminal. waitForDeviceCommand resolves on 'done' and REJECTS on
// 'error' OR timeout — so on rejection we re-read the real status: an existing pending/running command is a
// slow handshake ('pending', resumable); a null/absent row is 'missing' (not pending).
async function defaultWaitForCommandTerminal(commandId: string, timeoutMs?: number): Promise<CommandTerminal> {
  try {
    const cmd = await chatService.waitForDeviceCommand(commandId, timeoutMs)
    return cmd.status === 'error' ? 'error' : 'done'
  } catch {
    const cmd = await chatService.getDeviceCommand(commandId)
    if (cmd?.status === 'done') return 'done'
    if (cmd?.status === 'error') return 'error'
    if (cmd?.status === 'pending' || cmd?.status === 'running') return 'pending'
    return 'missing'
  }
}

export interface ProvisionRuntimeDeps {
  /** #7199 建的是个人助理:start 多带 child_harness / first_task(startAssistantProvisionOperation)。 */
  assistant?: AssistantStartExtras
  // Injectable for tests; defaults to the real polling waiter over chatService.
  waitForCommandTerminal?: (commandId: string, timeoutMs?: number) => Promise<CommandTerminal>
  commandTimeoutMs?: number
  // Injectable for tests; defaults to the real import_agent_provision_history RPC wrapper.
  importHistory?: (provisionId: string, payload: AgentHistoryImportInput) => Promise<string>
  initialMessage?: { messageId: string; text: string }
  /** 创建框里选的模型(`platform:` 前缀 = 咕咕平台模型)。重放时照传,库里按「与已记录的一致」校验。 */
  model?: string | null
  /** 思考强度档位 id(如 high)。同上。 */
  effort?: string | null
  /** 权限模式(GuguPermissionMode)。目标机器按这家 agent 的能力校验,不支持就失败。 */
  permissionMode?: string | null
}

// #2260 round-5 — the governed-removed CANCEL-ONLY state, detected client-side BEFORE any capacity request.
// `provisioned_agent_user_id` non-null with `agent_user_id` NULL means this member's exact agent was reclaimed by
// governed removal (evidence deliberately retained, live link nulled by the FK). That is a STABLE terminal-ish
// state: it can only converge through cancel/settle, so the renderer must fail loud here rather than ask claim for
// a slot (which would be rejected and would waste a grant) or hand it to prepare. prepare/claim still reject it
// server-side — those are the final race fences for a removal that commits mid-flight, not this state's detector.
export function assertMemberNotCancelOnly(row: AgentProvision): void {
  if (row.provisioned_agent_user_id && !row.agent_user_id) {
    throw new Error(
      `provision ${row.id} is governed-removed (agent ${row.provisioned_agent_user_id} reclaimed; evidence retained) — cancel/settle only, never re-provisioned; a new agent needs a NEW operation`,
    )
  }
}

// ── per-member primitive: prepare → wait TRUE terminal → settle → complete ──────────────────────────────
// Returns the durable member outcome. It does NOT throw on a member's create ERROR — that is a durable
// 'failed' phase, recoverable via same-agent retry, and the caller decides. It returns the still-awaiting
// row when the command has not reached a terminal yet (slow handshake) so the saga/UI can resume later.
export async function runClaimedMember(
  row: AgentProvision,
  deps: ProvisionRuntimeDeps = {},
  historyPayload?: AgentHistoryImportInput,
): Promise<AgentProvisionMemberOutcome> {
  const wait = deps.waitForCommandTerminal ?? defaultWaitForCommandTerminal

  // 1. prepare — advances preparing → awaiting_terminal. queued/failed must first receive a slot from claim;
  //    replay idempotently returns an already-advanced row: awaiting_terminal / ready / completed.
  const prepared = await prepareClaimedMember(row)
  if (prepared.phase === 'completed') {
    return { member: prepared }
  }

  // 2. wait for the agent.create command's TRUE terminal (spawn + ACP handshake). Skip only when a replay
  //    already settled the member to 'ready'.
  if (prepared.phase !== 'ready') {
    if (!prepared.create_command_id) {
      throw new Error(`prepared provision ${prepared.id} has no create command to await`)
    }
    const terminal = await wait(prepared.create_command_id, deps.commandTimeoutMs)
    if (terminal === 'pending') {
      // existing, still-nonterminal command (slow handshake) — leave it awaiting_terminal, resumable. NOT a failure.
      return { member: prepared }
    }
    if (terminal === 'missing') {
      // No command row. The only legitimate cause is an explicit cancel (which compare-and-deletes pending
      // commands). Re-read the member: cancelling/cancelled ⇒ durable cancellation outcome for the saga;
      // anything else is a genuine anomaly ⇒ fail loud (never silently pending/awaiting).
      const current = (await getProvision(prepared.id)) ?? prepared
      if (current.phase === 'cancelling' || current.phase === 'cancelled') {
        return { member: current }
      }
      throw new Error(
        `provision ${prepared.id} create command ${prepared.create_command_id} is missing but member phase is ${current.phase} (not a cancellation)`,
      )
    }
  }

  // 3. settle the true terminal into a durable phase (done→ready, error→failed). Idempotent if already settled.
  const settled = prepared.phase === 'ready' ? prepared : await settleProvisionTerminal(row.id)
  if (settled.phase === 'failed') {
    return { member: settled }
  }

  // 3b. required history import is a durable stage BEFORE the template (idempotent server-side by payload hash;
  //     complete rejects until the root lands). Skip once a root already exists (replay/resume).
  if (settled.history_import_required && !settled.history_thread_root_id) {
    if (!historyPayload) {
      throw new Error(`provision ${row.id} requires history import but no transcript payload was provided`)
    }
    const importHistory = deps.importHistory ?? importAgentProvisionHistory
    await importHistory(row.id, historyPayload)
  }

  // 4. complete — exactly-once template. Reachable only once settled 'ready', the command is done, AND any
  //    required history has landed (the RPC re-verifies all three). A single operation self-completes here.
  const template = await completeProvision(row.id)
  return {
    member: { ...settled, phase: 'completed', template_client_message_id: template.clientMessageId },
    template,
  }
}

// ── durable resume RECORD (persisted BEFORE the first RPC; fail-loud on write failure) ──────────────────
// The client mints operation + provision ids up front, so the resume pointer must carry the FULL replay
// intent — a bare operation id is useless because a fresh provisionSingleAgent call would mint DIFFERENT ids.
// Persisted per-owner (no cross-account global key), re-driven by resumeSingleAgent replaying start with the
// SAME ids + blueprint (idempotent → never a second operation). DB findResumableOperations() is the
// authoritative POST-start rediscovery, NOT a substitute for this pre-ack record (pre-ack has no DB row yet).
// ── client-only versioned source fingerprint (change-detection ONLY; SQL NEVER trusts it) ───────────────
// ONE deterministic serialization reused for the initial resume record AND resume-time reread comparison, so a
// memory/transcript source that changed locally before the first start/import is detected. Canonical (object
// keys sorted; array order preserved — transcript turn order is significant).
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`
}
export async function clientSourceDigest(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(payload))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return `v1:${Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`
}

// Per-member reference in the resume record: ids + client-only source refs/fingerprints. NO raw memory bytes
// and NO transcript turns are ever stored here (data-minimizing).
export interface ProvisionResumeMemberRef {
  provisionId: string
  memberKey: string
  memorySourceRef?: AgentProvisionMemorySourceRef
  historySourceRef?: AgentProvisionHistorySourceRef
}

export interface ProvisionResumeRecord {
  version: 2
  ownerUserId: string
  operationId: string
  deviceId: string
  blueprint: AgentProvisionBlueprint
  members: ProvisionResumeMemberRef[]
}

// Strict versioned deep schema (F3b/P1-e): reject a record whose nested shapes are malformed, missing a required
// field, or carry a legal-typed-but-illegal enum. The store never silently returns such a record — it fails loud
// (the caller preserves the raw bytes). MEMORY_PROVIDERS / LISTEN_MODES mirror the DB's strict allowlists.
const MEMORY_PROVIDERS: readonly string[] = ['claude-code', 'codex']
const LISTEN_MODES: readonly string[] = ['passive', 'active']
// @@@5856 档位收成两档之前存进 localStorage 的 resume 记录里躺着 'adaptive'。迁移只搬得动 DB 那份
// blueprint,搬不到这份。它不是非法值 —— 它就是今天的 'active'(同一个行为改了个名字),
// 与 packages/core/src/cloud/listenMode.ts 的 resolveListenModeDefault 用同一把尺。判成非法的后果不是报一个错,
// 是整个 store 被判成损坏 ⇒ list()/remember()/forget() 全抛 ⇒ 升级后连建单个 agent 都建不出来,且自愈不了。
const LEGACY_LISTEN_MODE = 'adaptive'
const normalizeListenMode = (raw: unknown): unknown => (raw === LEGACY_LISTEN_MODE ? 'active' : raw)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNonEmptyStr = (v: unknown): boolean => typeof v === 'string' && v.length > 0

// #2260 round-6 (P1-2): the two ref kinds get SEPARATE field-specific validators, selected by the CONTAINING FIELD
// — never inferred from "does it happen to have a `sources` key". Guessing the union let a memorySourceRef wear the
// history shape (and vice versa) and sail through, after which resume handed `undefined` sources or a missing
// filePath straight to the source reader. Each validator also forbids the OTHER kind's keys and any unknown key,
// so a cross-kind swap or a smuggled extra field is corrupt, not silently accepted.
const MEMORY_REF_KEYS = new Set(['sources', 'clientDigest'])
const HISTORY_REF_KEYS = new Set(['filePath', 'source', 'sessionId', 'clientDigest'])
const MEMBER_REF_KEYS = new Set(['provisionId', 'memberKey', 'memorySourceRef', 'historySourceRef'])
const hasOnlyKeys = (r: Record<string, unknown>, allowed: Set<string>): boolean =>
  Object.keys(r).every((k) => allowed.has(k))

const isProviderSet = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0
  && v.every((s) => MEMORY_PROVIDERS.includes(s as string))
  && new Set(v as string[]).size === v.length   // a repeated provider is corrupt, not a harmless duplicate

function isMemorySourceRefWellFormed(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  if (!hasOnlyKeys(r, MEMORY_REF_KEYS)) return false            // forbids filePath/source/sessionId + unknown keys
  return isProviderSet(r.sources) && isNonEmptyStr(r.clientDigest)
}
const sameProviderSet = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false
  const x = [...a].sort(), y = [...b].sort()
  return x.every((s, i) => s === y[i])          // order-insensitive: the SET is the intent, not its order
}
function isHistorySourceRefWellFormed(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  if (!hasOnlyKeys(r, HISTORY_REF_KEYS)) return false           // forbids sources + unknown keys
  return isNonEmptyStr(r.filePath) && isNonEmptyStr(r.source) && isNonEmptyStr(r.clientDigest)
    && (r.sessionId === undefined || isNonEmptyStr(r.sessionId))
}
// Validated against the member's BLUEPRINT INTENT: a memory ref may exist only when the blueprint member selected
// memory_sources, a history ref only when it declared history_import_required — and in both directions (declared
// intent without its ref is just as corrupt as a ref without the intent).
function isMemberRef(
  x: unknown,
  bpMember: { memory_sources?: unknown; history_import_required?: unknown } | undefined,
): x is ProvisionResumeMemberRef {
  if (!x || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  if (!hasOnlyKeys(r, MEMBER_REF_KEYS)) return false
  if (!isNonEmptyStr(r.provisionId) || !isNonEmptyStr(r.memberKey)) return false
  if (r.memorySourceRef !== undefined && !isMemorySourceRefWellFormed(r.memorySourceRef)) return false
  if (r.historySourceRef !== undefined && !isHistorySourceRefWellFormed(r.historySourceRef)) return false
  if (bpMember) {
    const wantsMemory = Array.isArray(bpMember.memory_sources) && bpMember.memory_sources.length > 0
    const wantsHistory = bpMember.history_import_required === true
    if (wantsMemory !== (r.memorySourceRef !== undefined)) return false
    if (wantsHistory !== (r.historySourceRef !== undefined)) return false
    // round-6b: presence parity is NOT enough — the ref must name EXACTLY the providers the blueprint selected.
    // A same-owner record declaring [claude-code] while its ref says [codex] used to pass this fence, and resume
    // then read the WRONG provider's local memory and shipped it to start, where only the SQL blueprint check
    // caught it — i.e. real source I/O before the pre-I/O corruption fence that exists precisely to stop it.
    if (wantsMemory) {
      const want = bpMember.memory_sources as unknown
      const got = (r.memorySourceRef as { sources?: unknown }).sources
      if (!isProviderSet(want) || !isProviderSet(got) || !sameProviderSet(want, got)) return false
    }
  }
  return true
}
// A blueprint member must carry the REQUIRED fields (ids + display_name + agent_type + strict booleans), an
// optional VALID-provider memory_sources, and a kind-appropriate listen_mode (team requires the enum; single
// forbids it). A shallow {provision_id,member_key} stub or an illegal enum is corrupt, not silently accepted.
function isBlueprintMemberWellFormed(m: unknown, kind: 'single' | 'team'): boolean {
  if (!m || typeof m !== 'object') return false
  const r = m as Record<string, unknown>
  if (!isNonEmptyStr(r.provision_id) || !isNonEmptyStr(r.member_key)) return false
  if (!isNonEmptyStr(r.display_name) || !isNonEmptyStr(r.agent_type)) return false
  if (typeof r.inherit_memory !== 'boolean' || typeof r.history_import_required !== 'boolean') return false
  if (r.memory_sources !== undefined && !isProviderSet(r.memory_sources)) return false   // same set rule as the ref
  if (r.existing_agent_user_id !== undefined && !isNonEmptyStr(r.existing_agent_user_id)) return false
  if (kind === 'team') { if (!LISTEN_MODES.includes(normalizeListenMode(r.listen_mode) as string)) return false }
  else if (r.listen_mode !== undefined) return false   // single forbids listen_mode
  return true
}
function isBlueprintWellFormed(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false
  const b = x as Record<string, unknown>
  if (b.kind !== 'single' && b.kind !== 'team') return false
  if (!Array.isArray(b.members) || b.members.length === 0) return false
  if (b.kind === 'single' && b.members.length !== 1) return false
  if (b.kind === 'team' && !(isNonEmptyStr(b.group_chat_id) && isStr(b.team_name) && isStr(b.group_prompt))) return false
  return b.members.every((mem) => isBlueprintMemberWellFormed(mem, b.kind as 'single' | 'team'))
}
export function isProvisionResumeRecord(x: unknown): x is ProvisionResumeRecord {
  if (!x || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  return (
    r.version === 2 &&
    typeof r.ownerUserId === 'string' &&
    typeof r.operationId === 'string' &&
    typeof r.deviceId === 'string' &&
    isBlueprintWellFormed(r.blueprint) &&
    Array.isArray(r.members) &&
    r.members.length > 0 &&
    // each ref is validated against ITS blueprint member (matched by member_key) so intent correspondence holds
    r.members.every((ref) => {
      const key = (ref as Record<string, unknown> | null)?.memberKey
      const bpm = ((r.blueprint as Record<string, unknown>).members as Record<string, unknown>[])
        .find((m) => m.member_key === key)
      return isMemberRef(
        ref,
        bpm as { memory_sources?: unknown; history_import_required?: unknown } | undefined,
      )
    })
  )
}

export interface ProvisionResumeStore {
  // MUST fail loud (throw) if the record cannot be persisted — a create must NOT proceed past a lost pre-ack record.
  remember(record: ProvisionResumeRecord): void
  forget(ownerUserId: string, operationId: string): void
  list(ownerUserId: string): ProvisionResumeRecord[]
}

// Owner-scoped key — NO cross-account global key. Reads are keyed by the CURRENT owner so a different account
// never sees another's records; the auth teardown boundary owns logout privacy cleanup.
const RESUME_STORE_PREFIX = 'gugu:agent-provision:pending:'

/**
 * 一份按主人分开的续建记录(localStorage)。默认那份归「新建 agent」(启动时 unfinishedSingleAgentSweep 会把没建完的单 agent 收掉);
 * #7199 个人助理另用一份(前缀不同,扫不到它):建到一半退出,下次打开引导接着建同一个,❌ 被当成没建完的普通 agent 撤掉。
 */
export function createResumeStore(prefix: string): ProvisionResumeStore {
  const resumeStoreKey = (ownerUserId: string): string => `${prefix}${ownerUserId}`
  const store: ProvisionResumeStore = {
    remember(record) {
      // No catch: a persistence failure BEFORE the first RPC aborts the create (fail loud); it is never swallowed.
      const rest = store.list(record.ownerUserId).filter((r) => r.operationId !== record.operationId)
      window.localStorage.setItem(resumeStoreKey(record.ownerUserId), JSON.stringify([...rest, record]))
    },
    forget(ownerUserId, operationId) {
      // F3b: list() fails loud on a corrupt store — forget must NOT swallow that. A silent swallow both hides the
      // corruption AND risks clobbering the preserved bytes; instead the corruption propagates and the raw bytes
      // are left untouched (only a clean read can safely rewrite/remove). forget is otherwise plain cleanup.
      const rest = store.list(ownerUserId).filter((r) => r.operationId !== operationId)
      const key = resumeStoreKey(ownerUserId)
      if (rest.length) window.localStorage.setItem(key, JSON.stringify(rest))
      else window.localStorage.removeItem(key)
    },
    list(ownerUserId) {
      const raw = window.localStorage.getItem(resumeStoreKey(ownerUserId))
      if (!raw) return []
      // FAIL LOUD + PRESERVE bytes on corruption — a corrupt entry must NEVER be silently dropped (that would lose
      // another operation's sole pre-ack source-ref recovery pointer, which is not in the DB) and remember() (which
      // reads through list()) must therefore never overwrite a corrupt store. Only an explicit, auditable repair may
      // delete. The raw bytes are left untouched here.
      let arr: unknown
      try {
        arr = JSON.parse(raw)
      } catch (err) {
        throw new Error(`resume store for ${ownerUserId} is corrupt (unparseable JSON) — refusing to read/overwrite (preserve + explicit repair required): ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!Array.isArray(arr)) {
        throw new Error(`resume store for ${ownerUserId} is corrupt (not an array) — refusing to read/overwrite (preserve + explicit repair required)`)
      }
      const malformed = arr.filter((r) => !isProvisionResumeRecord(r)).length
      if (malformed > 0) {
        throw new Error(`resume store for ${ownerUserId} has ${malformed} malformed record(s) — refusing to silently drop (preserve + explicit repair required)`)
      }
      // F3b: the storage-key owner MUST equal each record's self-declared ownerUserId. A mismatch is a cross-owner
      // leak/tamper (a record is keyed under, and belongs to, exactly ONE owner) — fail loud + preserve, never return.
      const crossOwner = (arr as ProvisionResumeRecord[]).filter((r) => r.ownerUserId !== ownerUserId).length
      if (crossOwner > 0) {
        throw new Error(`resume store for ${ownerUserId} has ${crossOwner} record(s) whose ownerUserId != the storage-key owner — refusing to read (cross-owner; preserve + explicit repair required)`)
      }
      // 读出来就归一:后面的 replay 会拿这份 blueprint 去撞服务端的新枚举,带着老值过去必被拒。
      // 在边界上改完,里层就只看得见两档。
      return (arr as ProvisionResumeRecord[]).map(withNormalizedListenModes)
    },
  }
  return store
}

export const defaultResumeStore: ProvisionResumeStore = createResumeStore(RESUME_STORE_PREFIX)

/** 把一条 resume 记录里的历史档位值归一成今天的两档(无老值时原样返回同一个对象)。 */
function withNormalizedListenModes(record: ProvisionResumeRecord): ProvisionResumeRecord {
  // single 的 blueprint 根本不许带 listen_mode（上面的校验器就是这么写的），所以只有 team 需要归一。
  const blueprint = record.blueprint
  if (blueprint?.kind !== 'team') return record
  // 类型上 listen_mode 已经只剩两档 —— 而磁盘上躺着的那份是**旧版本写的**，类型管不到它，所以这里按 string 比。
  const isLegacy = (member: { listen_mode?: string }) => member.listen_mode === LEGACY_LISTEN_MODE
  if (!blueprint.members.some(isLegacy)) return record
  return {
    ...record,
    blueprint: {
      ...blueprint,
      members: blueprint.members.map((member) => (
        isLegacy(member) ? { ...member, listen_mode: 'active' as const } : member
      )),
    },
  }
}

// Owner-scoped recovery boundary — MUST be enforced BEFORE any local source I/O or RPC. A resume record whose
// owner differs from the current auth owner (e.g. after an account switch) fails loud here so the previous
// account's local transcript/memory is never read. Also validates the record's kind + member refs ↔ blueprint.
export async function assertResumeRecordOwner(
  record: ProvisionResumeRecord,
  getOwnerUserId: () => Promise<string>,
  expectedKind: AgentProvisionKind,
): Promise<void> {
  const current = await getOwnerUserId()
  if (!current || current !== record.ownerUserId) {
    throw new Error(`resume: record owner ${record.ownerUserId} does not match current auth owner — refusing to read another account's sources`)
  }
  const bp = record.blueprint
  if (!bp || (bp.kind !== 'single' && bp.kind !== 'team')) {
    throw new Error('resume: record blueprint kind is invalid')
  }
  // caller-EXPECTED kind (F3a): a team record must never resume through the single entrypoint (which would
  // silently drive only members[0]) and a single record must never resume through the team entrypoint.
  if (bp.kind !== expectedKind) {
    throw new Error(`resume: record kind ${bp.kind} does not match the expected ${expectedKind} entrypoint`)
  }
  // TRUE bijection ref ↔ blueprint members (F3a): equal count, every blueprint member referenced EXACTLY once by
  // a ref whose provisionId matches that member's provision_id — no duplicate refs, no unreferenced member.
  const bpMembers = bp.members ?? []
  const bpByKey = new Map(bpMembers.map((m) => [m.member_key, m]))
  // P1-d: the blueprint's OWN member_keys must be unique — a Map dedups duplicates, so a blueprint with two members
  // sharing a member_key would otherwise pass the count check (size < array length) and slip a corrupt blueprint
  // (one member unreferenced) past this pre-I/O guard.
  if (bpMembers.length !== bpByKey.size) {
    throw new Error('resume: blueprint has duplicate member_key values — not a valid team (a true bijection needs unique blueprint member_keys)')
  }
  if (record.members.length === 0 || record.members.length !== bpByKey.size) {
    throw new Error('resume: record member refs do not form a bijection with blueprint members (count mismatch)')
  }
  const seen = new Set<string>()
  for (const ref of record.members) {
    const m = bpByKey.get(ref.memberKey)
    if (!m) throw new Error(`resume: member ref ${ref.memberKey} is not in the blueprint`)
    if (seen.has(ref.memberKey)) {
      throw new Error(`resume: duplicate member ref ${ref.memberKey} — refs must be a bijection with blueprint members`)
    }
    seen.add(ref.memberKey)
    if (ref.provisionId !== m.provision_id) {
      throw new Error(`resume: member ref ${ref.memberKey} provisionId ${ref.provisionId} does not match blueprint provision_id ${m.provision_id}`)
    }
  }
}

// ── blueprint builders (allowlisted keys only; optionals OMITTED when absent so the DB hash matches) ────

function buildBlueprintMember(
  m: AgentProvisionMemberInput & { provisionId: string },
  team: boolean,
): AgentProvisionBlueprintMember {
  const out: AgentProvisionBlueprintMember = {
    provision_id: m.provisionId,
    member_key: m.memberKey,
    display_name: m.displayName,
    agent_type: m.agentType,
    // REQUIRED explicit booleans — mirror the DB contract; never defaulted here.
    inherit_memory: m.inheritMemory,
    history_import_required: m.historyImportRequired,
  }
  if (m.projectPath) out.project_path = m.projectPath
  if (m.avatar) out.avatar = m.avatar
  if (m.specialFocus) out.special_focus = m.specialFocus
  if (m.existingAgentUserId) out.existing_agent_user_id = m.existingAgentUserId
  if (m.memorySources && m.memorySources.length > 0) out.memory_sources = m.memorySources
  if (team) {
    if (!m.listenMode) throw new Error('team member requires a listen_mode')
    out.listen_mode = m.listenMode
  }
  return out
}

export function buildSingleBlueprint(
  member: AgentProvisionMemberInput & { provisionId: string },
): SingleAgentProvisionBlueprint {
  return { kind: 'single', concurrency_limit: 1, members: [buildBlueprintMember(member, false)] }
}

export function buildTeamBlueprint(input: {
  groupChatId: string
  teamName: string
  groupPrompt: string
  concurrencyLimit?: number
  members: (AgentProvisionMemberInput & { provisionId: string })[]
}): TeamAgentProvisionBlueprint {
  return {
    kind: 'team',
    group_chat_id: input.groupChatId,
    team_name: input.teamName,
    group_prompt: input.groupPrompt,
    concurrency_limit: input.concurrencyLimit ?? 2,
    members: input.members.map((m) => buildBlueprintMember(m, true)),
  }
}

/**
 * 团队意图的**精确语义指纹** —— 用来回答「重进的这次预览，与某条已存 durable 记录是不是同一个团队意图」。
 *
 * ❌ 生成 id 不是身份:operation id / provision_id / member_key(=预览侧 tempId) / group_chat_id 每次都新铸,
 * 拿它们比必然认不出;服务端派生的 memory_content_hash 也不属于客户端意图。
 * ✅ 精确比:team_name / group_prompt / concurrency_limit,以及每个成员的**完整语义元组**
 * (display_name / agent_type / special_focus / inherit_memory / history_import_required / memory_sources /
 * listen_mode / project_path / avatar)。成员按**顺序无关**比较(序列化后排序 = 多重集合)。
 *
 * 任何语义分歧都必须走首建:接回旧 operation 等于拿旧意图冒充新意图 —— 用户换了引擎/改了 persona/改了章程/
 * 加减了成员却被静默套用旧配置,是本节点「冲突 payload 一律 fail loud」纪律直接禁止的。
 */
export function teamBlueprintIntentFingerprint(bp: TeamAgentProvisionBlueprint): string {
  const members = bp.members
    .map((m) => JSON.stringify([
      m.display_name,
      m.agent_type,
      m.special_focus ?? null,
      m.inherit_memory,
      m.history_import_required,
      m.memory_sources ? [...m.memory_sources].sort() : null,
      m.listen_mode ?? null,
      m.project_path ?? null,
      m.avatar ?? null,
    ]))
    .sort()
  return JSON.stringify([bp.team_name, bp.group_prompt, bp.concurrency_limit, members])
}

export function newProvisionId(): string {
  return crypto.randomUUID()
}

// ── single-agent full flow (kind='single', exactly one member, no group / no finalize) ──────────────────

export interface SingleProvisionResult {
  operationId: string
  provisionId: string
  operation: AgentProvisionOperation
  outcome: AgentProvisionMemberOutcome
}

export function completedSingleProvisionSession(
  result: SingleProvisionResult,
): CreateAgentOnDeviceResult {
  const member = result.outcome.member
  if (
    member.phase !== 'completed' ||
    !member.agent_user_id ||
    !member.dm_chat_id ||
    !member.create_command_id
  ) {
    throw new Error(
      `single provision ${result.provisionId} reported completed without its agent/DM/command binding`,
    )
  }
  return {
    agent: {
      id: member.agent_user_id,
      display_name: member.display_name,
      avatar: member.avatar,
      email: null,
      created_at: member.created_at,
    },
    commandId: member.create_command_id,
    chatId: member.dm_chat_id,
  }
}

// Device liveness is checked in the RENDERER (NOT a SQL precheck): the initial check refuses an already-offline
// target BEFORE the resume record is persisted or any RPC runs, and team drive performs a second binding check
// after the idempotent start read. Uses the existing derived is_online predicate (status + last_seen).
export async function defaultEnsureDeviceOnline(deviceId: string): Promise<void> {
  // The local Electron runtime is the authoritative liveness source for its own device. Avoid
  // making a cloud REST round-trip before the first provision RPC: a stalled data-plane request
  // used to leave the creation surface indefinitely in "creating" with no durable operation.
  const localSelf = await platform.getLocalDeviceSelfSnapshot?.()
  if (localSelf?.device_id === deviceId) {
    if (localSelf.is_online) return
    throw new Error(`device ${deviceId} is offline`)
  }
  // #6264 这台电脑用远程 SSH 添加的机器:在线只看这台电脑到它的设备连接(见 sshLinkChannel.ts)。
  if (await ensureSshMachineUsable(deviceId)) return
  const devices = await listDevicesOnceIdentified()
  const device = devices.find((d) => d.device_id === deviceId)
  if (device?.is_online) return
  // #7199 云电脑休眠中 ≠ 离线(规定草稿 cloud-computer):叫醒它,建 agent 的命令照常发出去 —— 命令进队列等它醒来领,
  // 管家也会因为这条待领的命令叫醒它。醒不来(积分用完 / 管家报错)就带着那句原因失败,❌ 说「离线」。
  if (device && (await wakeIfCloudComputer(deviceId))) return
  throw new Error(`device ${deviceId} is offline`)
}

/**
 * 这台是不是没醒着的云电脑;是就叫醒它(true)。管家此刻说它出错 = 抛(原因进日志)。
 * 问不到管家 = 不知道它是不是云电脑 ⇒ false,照普通离线说(❌ 把一台离线的笔记本说成「云电脑醒不来」)。
 */
async function wakeIfCloudComputer(deviceId: string): Promise<boolean> {
  let snapshot: Awaited<ReturnType<typeof refreshCloudComputer>>
  try {
    snapshot = await refreshCloudComputer()
  } catch {
    // refreshCloudComputer 已记过日志。
    return false
  }
  if (!snapshot || snapshot.deviceId !== deviceId) return false
  if (snapshot.state === 'error') throw new Error(snapshot.error ?? `cloud computer ${deviceId} reported an error`)
  // 醒着但它的 server 还没上线这几秒,同样照发:命令在队列里等它。
  if (snapshot.state === 'awake' || snapshot.state === 'waking' || snapshot.state === 'provisioning') return true
  if (snapshot.state !== 'asleep') return false
  await wakeCloudComputer()
  return true
}

// resume-time local source readers — must be injected (by the UI wiring / tests). Resume re-reads the local
// memory/transcript from the source ref; it NEVER reads raw bytes from storage (they were never stored).
const defaultReadMemory = async (): Promise<AgentMemoryContentInput | null> => {
  throw new Error('resume requires a readMemory provider (inject deps.readMemory)')
}
const defaultReadHistory = async (): Promise<AgentHistoryImportInput | null> => {
  throw new Error('resume requires a readHistory provider (inject deps.readHistory)')
}

export interface SingleProvisionDeps extends ProvisionRuntimeDeps {
  resumeStore?: ProvisionResumeStore
  newId?: () => string
  getOwnerUserId?: () => Promise<string>
  // Publish the durable identity immediately after remember(). The UI uses this exact record for every retry,
  // including errors thrown before start returns a row.
  onAttemptRecorded?: (record: ProvisionResumeRecord) => void
  // Emitted only after start_agent_provision_operation returns its durable row. Before this fence, a local record
  // is resumable but is not a valid destructive-cancel handle.
  onOperationAcknowledged?: (record: ProvisionResumeRecord) => void
  // raw cloud memory bytes for THIS member (keyed by source) — passed SEPARATELY to start (p_memory_content).
  memoryContent?: AgentMemoryContentInput
  // transcript payload for the required history-import stage + its durable source reference (for resume re-read).
  historyPayload?: AgentHistoryImportInput
  historySource?: { filePath: string; source: string; sessionId?: string }
  // online fast-fail before remember/start; injectable for tests (default = listDevices-derived is_online).
  ensureDeviceOnline?: (deviceId: string) => Promise<void>
  // versioned client-only fingerprint fn (default clientSourceDigest) — reused for record + resume compare.
  computeSourceDigest?: (payload: unknown) => Promise<string>
  // resume-time local source readers (return null when the source is missing).
  readMemory?: (sources: AgentMemorySource[]) => Promise<AgentMemoryContentInput | null>
  readHistory?: (ref: AgentProvisionHistorySourceRef) => Promise<AgentHistoryImportInput | null>
}

export async function provisionSingleAgent(
  deviceId: string,
  member: AgentProvisionMemberInput,
  deps: SingleProvisionDeps = {},
): Promise<SingleProvisionResult> {
  // Online fast-fail FIRST — before the resume record is persisted and before the first RPC (zero side effects
  // on an offline device).
  await (deps.ensureDeviceOnline ?? defaultEnsureDeviceOnline)(deviceId)
  const newId = deps.newId ?? newProvisionId
  const store = deps.resumeStore ?? defaultResumeStore
  const digest = deps.computeSourceDigest ?? clientSourceDigest
  const ownerUserId = await (deps.getOwnerUserId ?? getCurrentAuthUserId)()
  const operationId = newId()
  const provisionId = newId()
  const blueprint = buildSingleBlueprint({ ...member, provisionId })

  // Divergence fails loud (P1.5): memoryContent supplied without a matching memory_sources set is inconsistent
  // intent — surface it, do NOT silently drop it client-side (the DB's exact validation must be able to reject).
  if (deps.memoryContent && !(member.memorySources && member.memorySources.length > 0)) {
    throw new Error('provisionSingleAgent: memoryContent supplied without memory_sources (divergent memory input)')
  }
  const hasMemory = !!(member.memorySources && member.memorySources.length > 0 && deps.memoryContent)
  const memoryContentMap = hasMemory ? { [member.memberKey]: deps.memoryContent as AgentMemoryContentInput } : undefined

  // v2 member ref: ids + client-only source refs/fingerprints ONLY (no raw memory bytes, no transcript turns).
  const memberRef: ProvisionResumeMemberRef = { provisionId, memberKey: member.memberKey }
  if (hasMemory) {
    memberRef.memorySourceRef = { sources: member.memorySources as AgentMemorySource[], clientDigest: await digest(deps.memoryContent) }
  }
  if (member.historyImportRequired) {
    if (!deps.historySource || !deps.historyPayload) {
      throw new Error('history_import_required but no historySource/historyPayload supplied')
    }
    memberRef.historySourceRef = { ...deps.historySource, clientDigest: await digest(deps.historyPayload) }
  }

  const record: ProvisionResumeRecord = { version: 2, ownerUserId, operationId, deviceId, blueprint, members: [memberRef] }
  if (!isProvisionResumeRecord(record)) {
    throw new Error('provisionSingleAgent produced an invalid durable resume record')
  }
  // Persist the resume record BEFORE the first RPC. remember() fails loud → a failed persist issues zero RPCs.
  store.remember(record)
  deps.onAttemptRecorded?.(record)
  return driveSingleProvision(record, store, deps, { memoryContentMap, historyPayload: deps.historyPayload })
}

// Consume a durable resume record (crash / reload / lost start-ack). Rehydrates local sources from the record's
// client-only refs (fingerprint-verified), replays start with the SAME ids + blueprint (idempotent → never a
// second operation), and drives the member to its durable terminal. A failed member is retried on its SAME
// agent/DM by runClaimedMember (prepare's same-agent retry).
export async function resumeSingleAgent(
  record: ProvisionResumeRecord,
  deps: SingleProvisionDeps = {},
): Promise<SingleProvisionResult> {
  // owner-scoped recovery boundary FIRST — before ANY local source read or RPC (P1.3/F3a); single entrypoint.
  await assertResumeRecordOwner(record, deps.getOwnerUserId ?? getCurrentAuthUserId, 'single')
  const store = deps.resumeStore ?? defaultResumeStore
  const digest = deps.computeSourceDigest ?? clientSourceDigest
  const ref = record.members[0]
  if (!ref) throw new Error('resume record has no member ref')

  // Rehydrate memory: re-read the local source + verify the client fingerprint. Missing/changed ⇒ fail loud and
  // KEEP the record (the operation stays resumable/cancellable). Raw bytes are never read from storage.
  let memoryContentMap: Record<string, AgentMemoryContentInput> | undefined
  if (ref.memorySourceRef) {
    const content = await (deps.readMemory ?? defaultReadMemory)(ref.memorySourceRef.sources)
    if (!content) throw new Error(`resume: memory source for member ${ref.memberKey} is missing`)
    if ((await digest(content)) !== ref.memorySourceRef.clientDigest) {
      throw new Error(`resume: memory source for member ${ref.memberKey} changed (fingerprint mismatch)`)
    }
    memoryContentMap = { [ref.memberKey]: content }
  }

  // Rehydrate history: if the DB member already has a thread root, SKIP re-read/re-import; else re-read + verify.
  let historyPayload: AgentHistoryImportInput | undefined
  if (ref.historySourceRef) {
    const existing = await getProvision(ref.provisionId)
    if (!existing?.history_thread_root_id) {
      const payload = await (deps.readHistory ?? defaultReadHistory)(ref.historySourceRef)
      if (!payload) throw new Error(`resume: history source for member ${ref.memberKey} is missing`)
      if ((await digest(payload)) !== ref.historySourceRef.clientDigest) {
        throw new Error(`resume: history source for member ${ref.memberKey} changed (fingerprint mismatch)`)
      }
      historyPayload = payload
    }
  }

  return driveSingleProvision(record, store, deps, { memoryContentMap, historyPayload })
}

async function driveSingleProvision(
  record: ProvisionResumeRecord,
  store: ProvisionResumeStore,
  deps: SingleProvisionDeps,
  runtime: { memoryContentMap?: Record<string, AgentMemoryContentInput>; historyPayload?: AgentHistoryImportInput } = {},
): Promise<SingleProvisionResult> {
  const provisionId = record.members[0]?.provisionId
  if (!provisionId) throw new Error('resume record has no member ref')
  // start is idempotent on the same id + blueprint: a replay (response-loss / resume) returns the EXISTING
  // operation, never a second one. Raw memory (if any) rides p_memory_content, validated against the blueprint.
  const choice = { model: deps.model, effort: deps.effort, permissionMode: deps.permissionMode }
  const operation = deps.assistant
    ? await startAssistantProvisionOperation(record.operationId, record.deviceId, record.blueprint, choice, deps.assistant)
    : await startProvisionOperation(
        record.operationId,
        record.deviceId,
        record.blueprint,
        runtime.memoryContentMap,
        deps.initialMessage,
        choice,
      )
  deps.onOperationAcknowledged?.(record)
  // #2260 round-6 — SNAPSHOT-FIRST eight-state routing. claim_provision_slots is the ONLY capacity authority, and
  // the stable governed-removed (cancel-only) state must be caught BEFORE any capacity RPC — so the durable row is
  // read first and the precheck runs before every claim. A 'failed' member is RE-GRANTED through retry-selection and
  // is never handed straight to prepare (which rejects any row that is not slot-granted 'preparing').
  const snapshot = await getProvision(provisionId)
  // A missing row after a successful/replayed start is FAIL-LOUD — never a reason to claim blindly.
  if (!snapshot) throw new Error(`single provision ${provisionId} not found after start (durable row missing — refusing to claim blindly)`)
  assertMemberNotCancelOnly(snapshot)   // governed-removed → zero claim, zero prepare/run
  let row: AgentProvision
  if (snapshot.phase === 'queued') {
    const claimed = await claimProvisionSlots(record.operationId)
    const granted = claimed.find((c) => c.id === provisionId) ?? (await getProvision(provisionId))
    if (!granted || granted.phase !== 'preparing') {
      throw new Error(`single provision ${provisionId} was not granted a slot by claim_provision_slots (phase=${granted?.phase ?? 'missing'})`)
    }
    row = granted
  } else if (snapshot.phase === 'failed') {
    const regranted = await claimProvisionSlots(record.operationId, undefined, [provisionId])
    const granted = regranted.find((c) => c.id === provisionId) ?? (await getProvision(provisionId))
    if (!granted || granted.phase !== 'preparing') {
      throw new Error(`single provision ${provisionId} retry was not granted a slot by claim_provision_slots (phase=${granted?.phase ?? 'missing'})`)
    }
    row = granted
  } else {
    // preparing / awaiting_terminal / ready / completed — already claimed/in-flight: NO claim, drive idempotently.
    row = snapshot
  }

  const outcome = await runClaimedMember(row, deps, runtime.historyPayload)
  const finalOp = (await getProvisionOperation(record.operationId)) ?? operation
  // Clear the resume record only once the operation is truly terminal (completed/cancelled). A 'failed'
  // operation stays remembered — it is resumable via explicit same-agent retry.
  if (isTerminalOperationPhase(finalOp.phase)) {
    store.forget(record.ownerUserId, record.operationId)
  }
  return { operationId: record.operationId, provisionId, operation: finalOp, outcome }
}
