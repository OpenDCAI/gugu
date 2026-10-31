import type {
  AdmittedChannel, BoundIdentity, CapabilityGrant, ExitFact, Gen, Have, PlatformTicket, ProcessLease,
  ResolvedCli, StageName, StageOut, WorkspaceLease,
} from '@gugu/core/local/session-life/types';
import { resolveWorkspace } from '@main/core/projects/utils';
import { getSessions } from '@main/core/sessions/getSessions';
import { sessionService } from '@main/core/sessions/session-service';
import { readRuntimeForkOwnership, recordRuntimeForkOwnership } from '@main/core/sessions/runtime-fork-ownership';
import type { LegAdapter } from '../sessions/session-life-adapter';
import { acpAgentStatusBridge } from './agent-status-bridge';
import type { EmdashSessionIdentity } from './emdash-mcp-injector';
import { releaseEmdashPlatformSession } from './emdash-platform-injector';
import { injectEmdashPromptDetached } from './inject-prompt';
import {
  type AcpRuntimeClient, acpWorkerLease, callSessionStart, persistProviderSessionMissing, persistReturnedProviderSessionId,
  persistSessionMcpServers, provisionStartIdentity, readSessionInjectionFacts, stopAcpSessionAndSettle, withEmdashMcpInjection,
  withEmdashPlatformInjection, withHostResolvedCli,
} from './runtime-process/host';
import { resumeHistoryFacts } from './runtime-process/resume-history';
import { log } from '@main/lib/logger';
import { persistAcpStartResult } from './runtime-process/session-persistence-policy';

/**
 * The ACP leg of session-life. One instance per attempt: what a stage learned (the provisioned identity, the
 * injected start command) stays private to this attempt and reaches later stages only through `have`.
 *
 * Stage → existing operation:
 *   identity     the single ACP identity step (provisionStartIdentity)
 *   workspace    mount the session's workspace
 *   capabilities session facts + capability injection (consumes the identity, never provisions)
 *   platform     platform model ticket (none when the capability step already pinned it)
 *   cli          host-resolved CLI + resume history
 *   process      the ACP worker lease
 *   channel      this attempt's startSession returned: the worker answers only after SessionReady
 */

type Row = Awaited<ReturnType<typeof getSessions>>[number];
type StartInput = Parameters<AcpRuntimeClient['startSession']>[0];
type Facts = Awaited<ReturnType<typeof readSessionInjectionFacts>>;
type Lifecycle = 'fresh' | 'fork' | 'resume';
type Worker = Awaited<ReturnType<typeof acpWorkerLease>>;

// Branded leases: the reducer only carries them; their content belongs to this adapter.
type Workspace = { workspaceId: string; path: string };
type Capabilities = { injection: Awaited<ReturnType<typeof withEmdashMcpInjection<StartInput>>>; facts: Facts };
type Platform = { command: StartInput; injected: boolean };
type Cli = { command: Parameters<Worker['client']['startSession']>[0] };
const lease = <T>(value: T) => value as unknown;
const read = <T>(value: object): T => value as T;

function lifecycleOf(row: Row): Lifecycle {
  if (row.providerSessionId) return 'resume';
  return row.forkFromProviderSessionId ? 'fork' : 'fresh';
}

async function sessionRow(sessionId: string): Promise<Row> {
  const row = (await getSessions()).find(candidate => candidate.id === sessionId);
  if (!row) throw new Error(`Session ${sessionId} was not found`);
  if (row.runtime !== 'acp') throw new Error(`Session ${sessionId} is not an ACP session`);
  return row;
}

export function createAcpLegAdapter(sessionId: string): LegAdapter {
  let row: Row | null = null;
  let facts: Facts | null = null;
  let identity: EmdashSessionIdentity | null = null;

  const known = (): Row => { if (!row) throw new Error('ACP stage ran before identity'); return row; };

  async function startInput(workspace: Workspace): Promise<StartInput> {
    const { acpStartInputFor } = await import('@main/embedded-boot');
    const session = known();
    // Not yet claimed by a first start: the creation queue and a pending persistent fork ride on it.
    const unclaimed = session.providerSessionId == null;
    return {
      input: {
        ...acpStartInputFor(session, workspace.workspaceId, workspace.path),
        ...(unclaimed && session.forkFromProviderSessionId ? { forkFromProviderSessionId: session.forkFromProviderSessionId } : {}),
        ...(unclaimed && session.initialQueue?.length ? { initialQueue: session.initialQueue } : {}),
      },
    } as StartInput;
  }

  const stages: { [K in StageName]: (have: Have<K>, signal: AbortSignal, gen: Gen) => Promise<StageOut[K]> } = {
    async identity(): Promise<BoundIdentity> {
      row = await sessionRow(sessionId);
      if (!row.workspaceId) throw new Error(`Session ${sessionId} has no workspace`);
      // Read-only: the same path the workspace stage will mount, without mounting it yet.
      const cwd = resolveWorkspace(row.projectId, row.workspaceId)?.path;
      if (!cwd) throw new Error(`Session ${sessionId} workspace is unknown`);
      facts = await readSessionInjectionFacts({ sessionId });
      identity = await provisionStartIdentity({ sessionId, providerId: row.providerId, projectId: row.projectId, cwd }, lifecycleOf(row), facts);
      // A persisted session is never a runtime fork: no identity here means tombstoned or not provisionable.
      if (!identity) throw new Error(`Session ${sessionId} has no gugu identity and cannot be given one`);
      return { kind: 'bound', agentUserId: identity.guguAgentUserId };
    },
    async workspace(): Promise<WorkspaceLease> {
      const session = known();
      const mounted = await sessionService.ensureSessionMounted(sessionId);
      const workspace = resolveWorkspace(session.projectId, mounted.workspaceId);
      if (!workspace) throw new Error(`Session ${sessionId} workspace is not mounted`);
      return lease<Workspace>({ workspaceId: mounted.workspaceId, path: workspace.path }) as WorkspaceLease;
    },
    async capabilities(have): Promise<CapabilityGrant> {
      if (!facts) throw new Error('ACP capabilities ran before identity');
      const command = await startInput(read<Workspace>(have.workspace));
      const injection = await withEmdashMcpInjection(command, lifecycleOf(known()), facts, identity);
      return lease<Capabilities>({ injection, facts }) as CapabilityGrant;
    },
    async platform(have): Promise<PlatformTicket> {
      const { injection, facts: f } = read<Capabilities>(have.capabilities);
      const platform = await withEmdashPlatformInjection(
        injection.command, lifecycleOf(known()), f, injection.mcpServers, injection.sessionPrompt, injection.sessionMeta,
        injection.capabilitySpawnEnv, injection.capabilitySpawnArgs, injection.platformConfigured,
        injection.platformAccessSessionId, injection.platformModel,
      );
      return lease<Platform>({ command: platform.command, injected: platform.injected }) as PlatformTicket;
    },
    async cli(have): Promise<ResolvedCli> {
      const resolved = await withHostResolvedCli(read<Platform>(have.platform).command);
      const history = await resumeHistoryFacts(resolved.input, {});
      return lease<Cli>({ command: { ...resolved, input: { ...resolved.input, ...history } } }) as ResolvedCli;
    },
    async process(): Promise<ProcessLease> {
      return lease<Worker>(await acpWorkerLease()) as ProcessLease;
    },
    async channel(have, _signal, gen): Promise<AdmittedChannel> {
      const worker = read<Worker>(have.process);
      const { command } = read<Cli>(have.cli);
      const result = await callSessionStart(() => worker.client.startSession(command), sessionId, read<Platform>(have.platform).injected);
      await persistAcpStartResult(command.input, result, {
        persistReturnedProviderSessionId, persistProviderSessionMissing, recordRuntimeForkOwnership,
      });
      if (!result.success) throw new Error(`ACP session ${sessionId} did not start: ${result.error.message ?? result.error.type}`);
      const { injection, facts: f } = read<Capabilities>(have.capabilities);
      void import('../asks/human-tool-wait').then(({ restoreHumanToolResults }) =>
        restoreHumanToolResults(sessionId, command.input.projectId, true))
        .catch(error => log.error('Human tool results could not resume', { sessionId, error: String(error) }));
      void persistSessionMcpServers(sessionId, command.input.providerId, command.input.cwd, f.mcpDisabledServers, injection.extensionDelivery);
      return lease({ gen, timing: 'next-tool-call' }) as AdmittedChannel;
    },
  };

  return {
    leg: 'acp',
    timing: 'next-tool-call',
    run(at, have, ctx) {
      ctx.signal.throwIfAborted();
      return (stages[at] as (have: unknown, signal: AbortSignal, gen: Gen) => Promise<StageOut[typeof at]>)(have, ctx.signal, ctx.gen);
    },
    async dispatch(_have, pending) {
      const sent = await injectEmdashPromptDetached(sessionId, pending.message.text, { origin: 'manual' });
      if (sent.outcome === 'declined' || sent.outcome === 'missing') {
        return { result: 'rejected-before-admission', cause: { name: 'AdmissionDeclined', message: `The ACP runtime ${sent.outcome === 'missing' ? 'has no such session' : 'declined the prompt'}` } };
      }
      return { result: 'accepted', nativeReceiptId: sent.turnId ?? null };
    },
    async teardown(have) {
      if (have.process || have.channel) {
        await stopAcpSessionAndSettle((have.process ? read<Worker>(have.process) : await acpWorkerLease()).client, sessionId);
      } else if (have.platform || have.capabilities) await releaseEmdashPlatformSession(sessionId);
    },
    async endDependents() {
      // Side-chat forks are runtime children outside Life: they end only when the session itself ends.
      const forks = (await readRuntimeForkOwnership())
        .filter(fork => fork.sourceSessionId === sessionId && fork.status === 'active').map(fork => fork.runtimeSessionId);
      if (!forks.length) return;
      const { client } = await acpWorkerLease();
      const failures = (await Promise.allSettled(forks.map(id => stopAcpSessionAndSettle(client, id))))
        .flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, `${failures.length} runtime fork(s) of session ${sessionId} did not stop`);
    },
    onExit(have, cb) {
      const worker = read<Worker>(have.process);
      let fired = false;
      const exit = (fact: ExitFact) => { if (!fired) { fired = true; cb(fact); } };
      const gone = (message: string): ExitFact => ({ cause: { name: 'AcpSessionGone', message }, code: null, signal: null });
      const offWorker = worker.onGone(cause => exit(gone(cause)));
      // Only a summary this attempt has seen alive counts: a stale lost/closed of an earlier attempt is not this exit.
      let alive = false;
      const offSummary = acpAgentStatusBridge.watch(sessionId, summary => {
        if (!summary) { if (alive) exit(gone('ACP session left the runtime')); return; }
        if (summary.lifecycle !== 'lost' && summary.lifecycle !== 'closed') { alive = true; return; }
        if (!alive) return;
        // Our own stop also ends here; Life ignores it while stopping (state + generation).
        exit(summary.failure
          ? { cause: { name: summary.failure.kind, message: summary.failure.message },
            code: 'exitCode' in summary.failure ? summary.failure.exitCode : null,
            signal: 'signal' in summary.failure ? summary.failure.signal ?? null : null }
          : gone(`ACP session ${summary.lifecycle}`));
      });
      return () => { offWorker(); offSummary(); };
    },
  };
}

