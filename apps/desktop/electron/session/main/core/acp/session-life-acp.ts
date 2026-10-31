import { isHumanDmDelivery } from '@gugu/core/local/agent/deliveryEnvelope';
import { declaredInjectionTiming } from '@gugu/session-core/agents/plugins';
import { resolveSessionpageSessionIntegration } from '@gugu/session-plugins/agents';
import type { StartSessionInput } from '@gugu/session-core/acp';
import type {
  AdmittedChannel, BoundIdentity, CapabilityGrant, ExitFact, Gen, Have, PlatformTicket, ProcessLease,
  ResolvedCli, StageName, StageOut, WorkspaceLease,
} from '@gugu/core/local/session-life/types';
import { resolveWorkspace } from '@main/core/projects/utils';
import { getSessions } from '@main/core/sessions/getSessions';
import { sessionService } from '@main/core/sessions/session-service';
import { recordRuntimeForkOwnership } from '@main/core/sessions/runtime-fork-ownership';
import type { LegAdapter } from '../sessions/session-life-adapter';
import type { RuntimeFork } from '../sessions/session-life-forks';
import { localAgentForSession } from '@main/core/sessionpage/sessionpage-session-agent';
import { acpAgentStatusBridge } from './agent-status-bridge';
import type { EmdashSessionIdentity } from './emdash-mcp-injector';
import { releaseEmdashPlatformSession } from './emdash-platform-injector';
import { injectEmdashPromptDetached } from './inject-prompt';
import {
  acpWorkerLease, callSessionStart, persistProviderSessionMissing, persistReturnedProviderSessionId,
  persistSessionMcpServers, provisionStartIdentity, readSessionInjectionFacts, stopAcpSessionAndSettle, withEmdashMcpInjection,
  withEmdashPlatformInjection, withHostResolvedCli,
} from './runtime-process/host';
import { resumeHistoryFacts } from './runtime-process/resume-history';
import { renderFirstTurn } from '@gugu/core/local/agent/firstTurnRender';
import { ACP_START_FAILED } from '@shared/core/sessions/session-life';
import { lifeStore } from '../sessions/session-pending';
import { forkStore } from '../sessions/session-life-forks';
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
 *
 * A runtime fork (side chat, `fork` given) is the same leg over its parent's record: identity is the parent's binding
 * (read only; the fork's grant stays private, as the injector gives every runtime fork), the workspace is the parent's,
 * and it has no provider session of its own — it branches from the parent's.
 */

type Row = Awaited<ReturnType<typeof getSessions>>[number];
type StartInput = { input: StartSessionInput };
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

function lifecycleOf(row: Row, fork: RuntimeFork | null): Lifecycle {
  if (fork) return 'fork';
  if (row.providerSessionId) return 'resume';
  return row.forkFromProviderSessionId ? 'fork' : 'fresh';
}

async function sessionRow(sessionId: string): Promise<Row> {
  const row = (await getSessions()).find(candidate => candidate.id === sessionId);
  if (!row) throw new Error(`Session ${sessionId} was not found`);
  if (row.runtime !== 'acp') throw new Error(`Session ${sessionId} is not an ACP session`);
  return row;
}

export function createAcpLegAdapter(sessionId: string, fork: RuntimeFork | null): LegAdapter {
  let row: Row | null = null;
  let facts: Facts | null = null;
  let identity: EmdashSessionIdentity | null = null;

  const known = (): Row => { if (!row) throw new Error('ACP stage ran before identity'); return row; };

  async function startInput(workspace: Workspace): Promise<StartInput> {
    const { acpStartInputFor } = await import('@main/embedded-boot');
    const session = known();
    if (fork) {
      return { input: { ...acpStartInputFor(session, workspace.workspaceId, workspace.path), sessionId,
        sourceSessionId: fork.parentId, forkFromProviderSessionId: fork.forkFromProviderSessionId, providerSessionId: null } } as StartInput;
    }
    // Not yet claimed by a first start: a pending persistent fork rides on it. The creation turns are pending
    // rows (one queue), never part of the start.
    const unclaimed = session.providerSessionId == null;
    return {
      input: {
        ...acpStartInputFor(session, workspace.workspaceId, workspace.path),
        ...(unclaimed && session.forkFromProviderSessionId ? { forkFromProviderSessionId: session.forkFromProviderSessionId } : {}),
      },
    } as StartInput;
  }

  const stages: { [K in StageName]: (have: Have<K>, signal: AbortSignal, gen: Gen) => Promise<StageOut[K]> } = {
    async identity(): Promise<BoundIdentity> {
      if (fork) {
        row = await sessionRow(fork.parentId);
        facts = await readSessionInjectionFacts({ sessionId, sourceSessionId: fork.parentId });
        const agentUserId = (await localAgentForSession(fork.parentId, process.env))?.gugu_user_id;
        if (!agentUserId) throw new Error(`Side chat ${sessionId}: its session ${fork.parentId} has no gugu identity`);
        return { kind: 'bound', agentUserId };
      }
      row = await sessionRow(sessionId);
      if (!row.workspaceId) throw new Error(`Session ${sessionId} has no workspace`);
      // Read-only: the same path the workspace stage will mount, without mounting it yet.
      const cwd = resolveWorkspace(row.projectId, row.workspaceId)?.path;
      if (!cwd) throw new Error(`Session ${sessionId} workspace is unknown`);
      facts = await readSessionInjectionFacts({ sessionId });
      identity = await provisionStartIdentity({ sessionId, providerId: row.providerId, projectId: row.projectId, cwd }, lifecycleOf(row, null), facts);
      // A persisted session is never a runtime fork: no identity here means tombstoned or not provisionable.
      if (!identity) throw new Error(`Session ${sessionId} has no gugu identity and cannot be given one`);
      return { kind: 'bound', agentUserId: identity.guguAgentUserId };
    },
    async workspace(): Promise<WorkspaceLease> {
      const session = known();
      const mounted = await sessionService.ensureSessionMounted(fork?.parentId ?? sessionId);
      const workspace = resolveWorkspace(session.projectId, mounted.workspaceId);
      if (!workspace) throw new Error(`Session ${sessionId} workspace is not mounted`);
      return lease<Workspace>({ workspaceId: mounted.workspaceId, path: workspace.path }) as WorkspaceLease;
    },
    async capabilities(have): Promise<CapabilityGrant> {
      if (!facts) throw new Error('ACP capabilities ran before identity');
      const command = await startInput(read<Workspace>(have.workspace));
      // The injector lands a still-queued first turn's gugu message; it only needs that row's text.
      const firstTurn = (fork ? forkStore : lifeStore).rows(sessionId).find(row => row.turn.kind === 'chat-page-first-turn' && row.state === 'queued');
      const injection = await withEmdashMcpInjection(command, lifecycleOf(known(), fork), facts, identity, firstTurn?.message.text);
      return lease<Capabilities>({ injection, facts }) as CapabilityGrant;
    },
    async platform(have): Promise<PlatformTicket> {
      const { injection, facts: f } = read<Capabilities>(have.capabilities);
      const platform = await withEmdashPlatformInjection(
        injection.command, lifecycleOf(known(), fork), f, injection.mcpServers, injection.sessionPrompt, injection.sessionMeta,
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
      // The runtime's typed reason travels whole (in `data`): the task page turns it back into its specific
      // remedies (sign in, install, update, pick another model), the same as when a page started the runtime itself.
      if (!result.success) {
        throw Object.assign(new Error(`ACP session ${sessionId} did not start: ${result.error.message ?? result.error.type}`),
          { name: ACP_START_FAILED, data: JSON.stringify(result.error) });
      }
      const { injection, facts: f } = read<Capabilities>(have.capabilities);
      void import('../asks/human-tool-wait').then(({ restoreHumanToolResults }) =>
        restoreHumanToolResults(sessionId, command.input.projectId, true))
        .catch(error => log.error('Human tool results could not resume', { sessionId, error: String(error) }));
      void persistSessionMcpServers(sessionId, command.input.providerId, command.input.cwd, f.mcpDisabledServers, injection.extensionDelivery);
      const previous = fork ? null : known().providerSessionId ?? null;
      const nativeSession = previous === null ? null : result.data.providerSessionId === previous ? 'preserved' : 'replaced';
      return lease({ gen, timing: 'next-tool-call', nativeSession }) as AdmittedChannel;
    },
  };

  return {
    leg: 'acp',
    timing: 'next-tool-call',
    run(at, have, ctx) {
      ctx.signal.throwIfAborted();
      return (stages[at] as (have: unknown, signal: AbortSignal, gen: Gen) => Promise<StageOut[typeof at]>)(have, ctx.signal, ctx.gen);
    },
    async dispatch(have, pending) {
      const delivery = pending.message.delivery;
      const attachments = delivery?.attachments?.length ? { attachments: delivery.attachments } : {};
      let sent: Awaited<ReturnType<typeof injectEmdashPromptDetached>>;
      switch (pending.turn.kind) {
        case 'prompt': {
          // The row carries the sender's choice; an envelope's own origin is still read from its text.
          const origin = pending.turn.origin ?? delivery?.origin;
          // A delivery into a harness that takes input at its next tool call steers the running turn, unless the
          // sender asked to queue or it is a person's own DM (moved here from the old ACP delivery target, #4708).
          const steerIfBusy = !delivery?.queue && !isHumanDmDelivery(pending.message.text)
            && declaredInjectionTiming(resolveSessionpageSessionIntegration(known().providerId, 'acp')) === 'next-tool-call';
          sent = await injectEmdashPromptDetached(sessionId, pending.message.text, {
            ...(origin ? { origin } : {}),
            ...(steerIfBusy ? { steerIfBusy: true } : {}),
            ...(pending.turn.hiddenContext ? { hiddenContext: pending.turn.hiddenContext } : {}),
            ...(delivery?.coalesceKey ? { coalesceKey: delivery.coalesceKey } : {}),
            ...attachments,
          });
          break;
        }
        case 'chat-page-first-turn': {
          const render = read<Capabilities>(have.capabilities).injection.firstTurn;
          if (!render) throw new Error(`Session ${sessionId}: the first turn's gugu message did not land in this attempt`);
          const turn = renderFirstTurn(pending.message.text, render);
          sent = await injectEmdashPromptDetached(sessionId, turn.text, { origin: turn.origin, ...attachments });
          break;
        }
      }
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

