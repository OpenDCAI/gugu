import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ASSISTANT_CONTEXT_CORE } from '@gugu/core/shared/assistantWorkflow';
import { composeAgentSpawnEnv } from '@gugu/session-core/agents/agent-run-context';
import type { AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import { acpAgentStatusBridge } from '@main/core/acp/agent-status-bridge';
import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';
import { claudeTranscriptDirFor } from '@main/core/sessions/fork-lineage';
import { promoteAssistantContextCandidate } from '@main/core/sessions/set-session-id';
import { abandonAssistantContextMigration, assistantConversationVersion, claimAssistantContextMigration } from '@main/core/sessions/assistant-context-lease';
import { log } from '@main/lib/logger';
import { assistantTranscriptState, createAssistantContextCandidate } from '../../../../sessionpage/assistant-context-candidate';

type Registration = { sessionId: string; cwd: string; memoryDir: string; options: Record<string, unknown>; runContext: AgentRunContext; spawnEnv?: Record<string, string> };
const registrations = new Map<string, Registration>();
const attempts = new Set<string>();
const worked = new Set<string>();
let listening = false;

function atRest(sessionId: string): boolean {
  const state = acpAgentStatusBridge.current().get(sessionId);
  return state?.lifecycle === 'ready' && !state.isGenerating && state.queuedPromptCount === 0
    && state.pendingPermissionCount === 0 && state.backgroundAgentCount === 0 && state.backgroundCommandCount === 0;
}

async function recoveryState(memoryDir: string): Promise<{ hash: string; references: string[] }> {
  const files = await Promise.all(['pending-work.json', 'working-context.md'].map(async name => {
    try { return await readFile(join(memoryDir, name), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  }));
  const pending = files[0] ? JSON.parse(files[0]) : { items: [] };
  const references = pending.items.filter((row: { state: string }) => row.state !== 'needs_source' && row.state !== 'dispatching')
    .flatMap((row: { id: string; source_link?: string; source_message_id?: string }) => [row.id, row.source_link, row.source_message_id].filter(Boolean));
  return { hash: createHash('sha256').update(JSON.stringify(files)).digest('hex'), references };
}

/** Only the trusted personal-assistant preparation path registers; task agents do not subscribe. */
export function registerAssistantContextMigration(registration: Registration): void {
  registrations.set(registration.sessionId, registration);
  attempts.delete(registration.sessionId);
  worked.delete(registration.sessionId);
  if (acpAgentStatusBridge.current().get(registration.sessionId)?.isGenerating) worked.add(registration.sessionId);
  if (!listening) {
    listening = true;
    agentStatusWriter.on('agent:status', ({ sessionId, reading }) => {
      if (reading.status === 'working' && registrations.has(sessionId)) worked.add(sessionId);
      if (reading.status === 'idle' && worked.has(sessionId)) queueMicrotask(() => schedule(sessionId));
    });
  }
  // An initial ready/idle snapshot can precede the inbox's first admission. Do
  // not take its lease ahead of the very message which woke this conversation;
  // maintenance starts only after an observed working -> idle transition.
}

function schedule(sessionId: string): void {
  const registration = registrations.get(sessionId);
  if (!registration || attempts.has(sessionId) || !atRest(sessionId)) return;
  attempts.add(sessionId); // Failed candidates retry on the next wake/registration, not every idle edge.
  void migrate(registration).catch(error => log.warn('assistant native context migration abandoned', {
    sessionId, error: error instanceof Error ? error.message : String(error),
  }));
}

async function migrate(registration: Registration): Promise<void> {
  const { sessionId, cwd, memoryDir, options } = registration;
  const prompt = options.systemPrompt as { prompt?: string } | undefined;
  const rules = [...new Set([...ASSISTANT_CONTEXT_CORE.filter(line => line.startsWith('- ')),
    ...(prompt?.prompt ?? '').split('\n').filter(line => line.startsWith('- '))])];
  const runtime = registration.runContext;
  if (runtime.cli.kind !== 'resolved' || !runtime.acpAdapterEntry) return;
  const env = { ...composeAgentSpawnEnv(runtime, { hostInjections: [registration.spawnEnv, options.env as Record<string, string>] }), ELECTRON_RUN_AS_NODE: '1' };
  const { getSessions } = await import('@main/core/sessions/getSessions');
  const source = (await getSessions()).find(row => row.id === sessionId)?.providerSessionId;
  if (!source || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source) || !atRest(sessionId)) return;
  const path = join(claudeTranscriptDirFor(cwd, env), `${source}.jsonl`);
  const before = await assistantTranscriptState(path, rules);
  if (!before.duplicate) return;
  const recovery = await recoveryState(memoryDir);
  if (!atRest(sessionId)) return;
  const lease = claimAssistantContextMigration(sessionId, source);
  if (!lease) return;
  const version = assistantConversationVersion(sessionId);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 35_000);
  let stoppedOriginal = false;
  try {
    // Resolve SDK and credentials only from this conversation's host-selected runtime.
    const candidate = await createAssistantContextCandidate({ node: runtime.runtimeExecutable ?? process.execPath,
      adapter: runtime.acpAdapterEntry, executable: runtime.cli.path, source, sourcePath: path, cwd,
      candidate: lease.candidateProviderSessionId,
      options, env, rules, references: recovery.references,
    }, abort.signal);
    if (abort.signal.aborted || !atRest(sessionId) || assistantConversationVersion(sessionId) !== version
      || (await assistantTranscriptState(path, rules)).hash !== before.hash
      || (await recoveryState(memoryDir)).hash !== recovery.hash) throw new Error('Source, queue or pending work changed during migration');
    const { getAcpRuntimeClient } = await import('@main/core/acp/controller');
    const client = await getAcpRuntimeClient();
    const stopped = await client.stopSession({ sessionId });
    if (!stopped.success) throw new Error('Original runtime could not be quiesced');
    stoppedOriginal = true;
    if (!promoteAssistantContextCandidate({ ...lease, candidateProviderSessionId: candidate, expectedVersion: version })) throw new Error('Candidate promotion lost its lease or source version');
    log.info('assistant native context migration completed', { sessionId, previousProviderSessionId: source, candidateProviderSessionId: candidate });
  } finally {
    clearTimeout(timeout);
    // Also resumes the original on a failed promotion. Restart reads the persisted
    // provider id, never a renderer snapshot or an unverified candidate id.
    try {
      if (stoppedOriginal) {
        const { ensureEmdashSession } = await import('../../embedded-boot');
        await ensureEmdashSession(sessionId);
      }
    } catch (error) { log.warn('assistant context runtime resume failed', { sessionId, error: String(error) }); }
    finally {
      abandonAssistantContextMigration(lease, 'Candidate discarded or maintenance finished');
      const { notifySessionLive } = await import('@main/core/sessions/session-message-router');
      notifySessionLive(sessionId);
    }
  }
}
