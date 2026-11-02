import { randomUUID } from 'node:crypto';
import type { AppCallAction, RemoteAppCaller } from '@gugu/session-core/session-record/contract';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { appCallAction, notOnSessionMachine, overCallLimit } from '@shared/extensions/machine-call';
import { machineVerbs } from '@main/core/extensions/machine-verbs';
import type { MachineVerb, PlaceVerb } from '@shared/extensions/bridge-protocol';
import { callRefusal } from '@shared/extensions/bridge-protocol';
import { log } from '@main/lib/logger';

/**
 * A page's calls that follow its session's machine (owner 10-16, 「页面跟着人，程序跟着数据」; `BRIDGE_VERBS` rows with
 * `machine`: the App's data folder and its program) are done on the machine that session is on — the rule the right
 * panel's Files and Review follow (owner 09-25). Every other place (a chat's panel, the dock, the background page) has no
 * machine of its own and keeps this computer's. Across machines the call is `agentSession.app_call` over `taskhost.call`,
 * beside an App's `message`; there it is that machine's call, with its install, consent and switches, done
 * by the same `machineVerbs` a page there calls.
 */

/** A session not on this computer, and the machine it is on. Sessions never move machines, so a found one is kept. */
export type SessionMachine = { deviceId: string; deviceLabel: string | null; projectId: string | null; agentId: string | null };
const machines = new Map<string, SessionMachine>();

/**
 * The machine a session is on, when it is not this one: null for a session of this computer. Asked of the person's
 * other online machines (the list `dispatch` to an agent and `files` across machines read); a session none of them has throws
 * `not-found`, naming the machines that could not be asked.
 */
export async function sessionMachine(sessionId: string): Promise<SessionMachine | null> {
  const { agentSessionContext } = await import('@main/core/extensions/extension-agent-context');
  if (await agentSessionContext(sessionId)) return null;
  const known = machines.get(sessionId);
  if (known) return known;
  const { sessionsElsewhere } = await import('@main/core/extensions/extension-agents');
  const { rows, unreached } = await sessionsElsewhere();
  for (const { session, deviceId, deviceLabel } of rows) {
    if (!deviceId) continue;
    machines.set(session.conversationId, {
      deviceId,
      deviceLabel,
      projectId: session.projectId || null,
      agentId: session.agent ? `user:${session.agent.userId}` : null,
    });
  }
  const found = machines.get(sessionId);
  if (found) return found;
  const tail = unreached.length ? ` (not asked: ${unreached.map((machine) => machine.label ?? machine.detail).join(', ')})` : '';
  throw Object.assign(new Error(`Session ${sessionId} is not on this computer or on your other online computers${tail}`), {
    code: unreached.length ? 'unavailable' : 'not-found',
  });
}

/** The machines found so far, for whoever asks which pages a machine's push is for. */
export function knownSessionMachine(sessionId: string): SessionMachine | undefined {
  return machines.get(sessionId);
}

/** The cross-machine codes, as a page reads them: the machine is offline, too old, not reachable or did not answer. */
const UNAVAILABLE = new Set([
  'SESSION_DEVICE_OFFLINE',
  'SESSION_DEVICE_OUTDATED',
  'SESSION_DEVICE_UNREACHABLE',
  'SESSION_DEVICE_NO_ANSWER',
  'SESSION_DEVICE_SIGN_IN_REQUIRED',
  'SESSION_DEVICE_UNKNOWN',
]);

/**
 * This computer's page has one of those calls done on the machine its session is on: `{ there: false }` for a session of
 * this computer. The id of the call travels with it, so a request sent again after a lost answer joins the call already
 * made there instead of making a second one.
 */
export async function callOnSessionMachine(
  app: { extensionId: string; manifest: ExtensionManifest },
  sessionId: string | { deviceId: string },
  method: string,
  args: Record<string, unknown>,
  workedByAgent: boolean,
): Promise<{ there: false } | { there: true; value: unknown }> {
  const { otherMachines } = await import('@main/core/sessions/session-family');
  const machine = typeof sessionId === 'string' ? await sessionMachine(sessionId)
    : await otherMachines().isThisDevice(sessionId.deviceId) ? null : sessionId;
  if (!machine) return { there: false };
  const invalid = notOnSessionMachine(app.manifest, method, args);
  if (invalid) throw invalid;
  if (workedByAgent && method === 'callProgram') {
    throw Object.assign(new Error('A page an agent works calls its program on this computer only; this session is on another machine'), { code: 'invalid' });
  }
  const action = appCallAction(sessionId, app.manifest.version, method, args, randomUUID());
  const tooLarge = overCallLimit('call', action, action);
  if (tooLarge) throw tooLarge;
  try {
    return { there: true, value: await otherMachines().appCall({ extensionId: app.extensionId, extensionName: app.manifest.name }, machine.deviceId, action) };
  } catch (error) {
    // That machine's offline / too old / unreachable / silent, as the page reads it: `unavailable`; its own refusals keep their code.
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && UNAVAILABLE.has(code)) throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: 'unavailable' });
    throw error;
  }
}

/** Calls answered here for another machine, by the id that machine gave each: a call sent again joins its first. */
const answered = new Map<string, { at: number; result: Promise<unknown> }>();
/**
 * How long an answer is kept for a call sent again, from when the call came: the asker sends it again at most once, one
 * timeout (75 s) later, and its wait for that one is another 75 s.
 */
export const APP_CALL_KEPT_MS = 3 * 60_000;
/** At most this many kept at once (each up to 1 MB): the newest, a page calling often is not stored without bound. */
export const APP_CALLS_KEPT = 64;

/**
 * The other side: a page on another of the person's machines (a desktop or the phone) has one of its calls done for a
 * session on this computer. It is done as a page's call made here would be — this machine's install, switch,
 * `agents:tools` — and only when both have the same version of the App: a page and its program are one App, never two
 * halves of different releases. Each refusal carries the code the page branches on.
 */
export async function answerAppCall(caller: RemoteAppCaller, action: AppCallAction, now = Date.now()): Promise<unknown> {
  for (const [id, kept] of answered) if (now - kept.at > APP_CALL_KEPT_MS) answered.delete(id);
  const key = `${caller.deviceId}/${action.call_id}`;
  const first = answered.get(key);
  if (first) return await first.result;
  let reached = false;
  const result = (async () => {
    await admit(caller, action);
    reached = true;
    const value = await machineVerbs[action.method as MachineVerb | PlaceVerb](caller.extensionId, action.args, action.session_id ? { sessionId: action.session_id } : {});
    const tooLarge = overCallLimit('answer', action, value);
    if (tooLarge) throw tooLarge;
    log.info('[app-programs] a call done for a page on another machine', { device: caller.deviceId, app: caller.extensionId, session: action.session_id, method: action.method });
    return value;
  })();
  answered.set(key, { at: now, result });
  for (const id of answered.keys()) {
    if (answered.size <= APP_CALLS_KEPT) break;
    answered.delete(id);
  }
  // A refusal before the call is reached is not kept: asked again, it is decided again (installed meanwhile, say).
  // What came after — the answer, the program's own error, an answer too large — is that call's: one sent again joins it.
  result.catch(() => {
    if (!reached) answered.delete(key);
  });
  return await result;
}

/**
 * What a page on another machine may have done here: a verb that follows the session's machine, of this App installed,
 * the same version as its page, switched on (a program also still giving agents tools), for a session on this machine.
 */
async function admit(caller: RemoteAppCaller, action: AppCallAction): Promise<void> {
  const [{ agentSessionContext }, { extensionsService }, { extensionPrograms }] = await Promise.all([
    import('@main/core/extensions/extension-agent-context'),
    import('@main/core/extensions/extensions-root'),
    import('@main/core/extensions/extension-programs'),
  ]);
  const service = extensionsService();
  const tooLarge = overCallLimit('call', action, action);
  if (tooLarge) throw tooLarge;
  let manifest: ExtensionManifest;
  try {
    manifest = service.get(caller.extensionId).manifest;
  } catch {
    throw Object.assign(new Error(`${caller.extensionName} is not installed on this machine`), { code: 'not-installed' });
  }
  const elsewhere = notOnSessionMachine(manifest, action.method, action.args);
  if (elsewhere) throw elsewhere;
  if (manifest.version !== action.version) {
    throw Object.assign(new Error(`${caller.extensionName} is ${manifest.version} on this machine and ${action.version} where its page is; install the same version on both`), { code: 'version-mismatch' });
  }
  const capability = callRefusal(action.method, action.args, { kind: 'program', has: (word) => service.hasCapability(caller.extensionId, word) });
  if (capability) throw Object.assign(new Error(capability.message), { code: capability.code });
  const refusal = action.method === 'callProgram' ? extensionPrograms.agentToolsRefusal(caller.extensionId)
    : service.isEnabled(caller.extensionId) ? null : `Extension ${caller.extensionId} is turned off`;
  if (refusal) throw Object.assign(new Error(refusal), { code: 'denied' });
  if (action.device_id) {
    const { otherMachines } = await import('@main/core/sessions/session-family');
    if (!(await otherMachines().isThisDevice(action.device_id))) throw Object.assign(new Error('App call targets another machine'), { code: 'invalid' });
  } else if (!action.session_id || !(await agentSessionContext(action.session_id))) {
    throw Object.assign(new Error(`Session ${action.session_id} is not on this machine`), { code: 'not-found' });
  }
}
