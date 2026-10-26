import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { buildExtensionEnvelope, formatDeliveryTimestamp } from '@gugu/core/local/agent/deliveryEnvelope';
import { extensionsService } from '@main/core/extensions/extensions-root';
import { currentAccountAccessToken } from '@main/core/extensions/account-token';
import { AppSendError, dispatchFromApp, type DispatchHere } from '@shared/extensions/app-send-core';
import { createAppMessages } from '@shared/extensions/app-messages-core';
import { createAppForum, type ForumChannel } from '@shared/extensions/app-forum-core';
import { subscribeStatusName } from '@gugu/core/cloud/deviceRpcProtocol';
import { log } from '@main/lib/logger';
import { supabase } from '../../../../supabase';
import { subscribeAuthenticatedElectronRealtimeChannel, type ElectronManagedRealtimeChannel } from '../../../../realtime-channel';
import type { AppMessageAction, AppMessageOptions, AppMessageReceipt, RemoteAppCaller } from '@gugu/session-core/session-record/contract';
import type { AppComposeDetail } from '@shared/extensions/app-runtime-protocol';
import type { DispatchAsk, DispatchPicked } from '@shared/extensions/app-dispatch-core';
import type { AgentReach } from '@shared/extensions/manifest';

/** The codes an App reads off a failed send — the same whether the agent is here or on another computer. */
const APP_SEND_CODES = ['denied', 'invalid', 'not-found', 'rate-limited', 'failed'] as const satisfies readonly AppSendError['code'][];

/**
 * How an App hands something to someone, on the desktop (`gugu.dispatch`, 15): the shared answer (`dispatchFromApp`,
 * `app-send-core.ts`, the phone's too) with what only this computer has — the window's sheet and composers, and the
 * person's agents: one here told as `session_message` tells it, one on another computer through its machine, a new one
 * started. The target is the call's or the person's, never where the page is (真源原则 13).
 */

export { AppSendError };

async function account(): Promise<{ token: string; userId: string }> {
  const token = await currentAccountAccessToken();
  const userId = token ? userIdFromSupabaseAccessToken(token) : null;
  if (!token || !userId) throw new AppSendError('failed', 'Not signed in');
  return { token, userId };
}

/** `gugu.messages`: a chat's messages, read with the same account (the shared answer, `app-messages-core.ts`, the phone's too). */
export const messagesForApp = createAppMessages({ account });

/** A forum channel on main's realtime client, as the person (the device command wake's way: re-subscribed when it drops). */
const forumChannel: ForumChannel = (topic, event, onPayload, onSubscribed) => {
  let stop: (() => Promise<void>) | null = null;
  let stopped = false;
  const create = () =>
    (supabase.channel(topic, { config: { private: true, broadcast: { self: false, ack: true } } }) as unknown as {
      on(kind: 'broadcast', filter: { event: string }, fn: (message?: { payload?: Record<string, unknown> }) => void): ElectronManagedRealtimeChannel;
    }).on('broadcast', { event }, (message) => onPayload(message?.payload ?? {}));
  void (async () => {
    await account();
    const unsubscribe = await subscribeAuthenticatedElectronRealtimeChannel(
      { realtime: supabase.realtime, removeChannel: (channel) => supabase.removeChannel(channel as never) },
      create(),
      {
        label: `forum:${topic}`,
        createChannel: create,
        onStatus: (status) => {
          const name = subscribeStatusName(status);
          if (!stopped && (name === 'SUBSCRIBED' || name.endsWith('.SUBSCRIBED'))) onSubscribed();
        },
      },
    );
    if (stopped) await unsubscribe();
    else stop = unsubscribe;
  })().catch((error: unknown) => log.error({ topic, err: error instanceof Error ? error.message : String(error) }, 'forum channel did not subscribe'));
  return () => {
    stopped = true;
    void stop?.();
  };
};

/** `gugu.forum`: the forum, read and written with the same account (the shared answer, `app-forum-core.ts`, the phone's too). */
export const forumForApp = createAppForum({ account, channel: forumChannel });

/** What the bridge brings to one call: the window's sheet, its composers, and the agent working the page (its session). */
export interface DesktopDispatchEffects {
  pick(ask: DispatchAsk): Promise<DispatchPicked>;
  draftInChat(detail: AppComposeDetail): Promise<void>;
  draftInSession(session: { id: string; projectId: string }, text: string): Promise<void>;
  from?: string;
}

/**
 * `gugu.dispatch` on the desktop. An agent the call names is one this App reaches (`agents:control`: the ones it started,
 * `:all` every one here, `:all-machines` also the person's other computers'); one the person picked in the sheet is any of
 * theirs, told here or on its computer. A draft goes into an agent's composer here: words only (pills go into a chat's).
 */
export async function dispatchForApp(
  extensionId: string,
  args: Record<string, unknown>,
  page: Omit<DispatchHere, 'preselect' | 'local'> & { session: string | null },
  effects: DesktopDispatchEffects,
): Promise<{ to: unknown; id?: string; deferred?: true } | { cancelled: true }> {
  const app = { extensionId, extensionName: extensionsService().get(extensionId).manifest.name };
  const { visibleAgentsForExtension, spawnAgentForExtension } = await import('@main/core/extensions/extension-agents');
  // This computer's agents → their sessions: a draft's only composers, and for the sheet the page's own agent, ticked first.
  const agentsHere = () => visibleAgentsForExtension({ scope: 'all', extensionId });
  const sheet = args.to === undefined || args.to === null ? await agentsHere() : null;
  const { session, ...rest } = page;
  const here: DispatchHere = {
    ...rest,
    preselect: (sheet && session && [...sheet].find(([, conversation]) => conversation === session)?.[0]) || null,
    ...(sheet ? { local: [...sheet.keys()] } : {}),
  };
  return dispatchFromApp(
    {
      account,
      pick: effects.pick,
      draftInChat: effects.draftInChat,
      agents: {
        async draft(agent, text) {
          if (!text) throw new AppSendError('invalid', 'Nothing to compose: text is empty');
          const sessionId = (await agentsHere()).get(agent.agent);
          const { agentSessionContext } = await import('@main/core/extensions/extension-agent-context');
          const facts = sessionId ? await agentSessionContext(sessionId) : null;
          if (!sessionId || !facts?.projectId) throw new AppSendError('not-found', `${agent.agent} is not an agent on this computer`);
          await effects.draftInSession({ id: sessionId, projectId: facts.projectId }, `${text}\n`);
          return agent.agent;
        },
        async tell(agent, text, how) {
          // Named by the call: within the App's own reach. Picked by the person: any of theirs, here or on its computer.
          const reach = agent.named ? extensionsService().agentReach(extensionId, 'agents:control') : 'all-machines';
          const receipt = await messageAgentFromHostApp(app, reach, { agentId: agent.agent, text, ...how }, { from: effects.from });
          return { agent: agent.agent, ...receipt };
        },
        async spawn(prompt, spawn) {
          // Checked where the call is read (app-dispatch-core `spawnOf`): a wrong field is refused there, never dropped here.
          const { agentId } = await spawnAgentForExtension({ ...app, bySession: effects.from, prompt, ...spawn });
          return agentId;
        },
      },
    },
    extensionId,
    args,
    here,
  );
}

/**
 * Tell a session on this computer something, as this App: `session_message`'s delivery (a stopped or reclaimed session
 * is woken, with its history, then told.
 */
async function tellSessionFromApp(
  /** The name is the installed manifest's (here, or on the App's machine), never the call's: it is how the agent and the person tell one App from another. */
  app: { extensionId: string; extensionName: string },
  sessionId: string,
  text: unknown,
  /** `to`: what the call named the session by — in why it was not told. `from`: the agent's session that works the page. */
  options: AppMessageOptions & { to: string; from?: string },
): Promise<AppMessageReceipt> {
  const said = String(text ?? '').trim();
  if (!said) throw new AppSendError('invalid', 'Say something: text is empty');
  const { extensionId, extensionName } = app;
  const delivery = { delivery: options.delivery, key: options.key, keyScope: `app:${extensionId}`, from: options.from };
  // Why it was not told, in the session layer's words — naming the agent as the App did (F35), never by its session.
  const refused = (error: unknown): never => {
    const why = error instanceof Error ? error.message : String(error);
    throw new AppSendError('failed', why.replaceAll(sessionId, options.to));
  };
  const { messageSessionFrom } = await import('@main/core/sessions/session-orchestration');
  return messageSessionFrom(
    (messageId, content) =>
      buildExtensionEnvelope({ extensionId, extensionName, messageId, content, at: formatDeliveryTimestamp(new Date().toISOString()) }),
    sessionId,
    said,
    delivery,
  ).catch(refused);
}

/**
 * Telling one of the agents an App reaches (`dispatch` to `{ agent }`): `agentId` (`user:<uuid>`, as `listAgents` gives it)
 * among those `reach` covers — here, or with `all-machines` on the person's other online computers (found in the same task
 * lists `listAgents` reads). `from`: the session of the agent that works the page (owner 10-14) — it is the one telling.
 * Installed Apps enter through `dispatchForApp`; built-in Apps must authorize their fixed recipient before entering here.
 * This is not a renderer/remote RPC entry point and accepts no permission claims from an App page.
 */
export async function messageAgentFromHostApp(
  app: { extensionId: string; extensionName: string },
  reach: AgentReach,
  args: { agentId: string; text: unknown } & AppMessageOptions,
  options: { from?: string } = {},
): Promise<AppMessageReceipt> {
  const { extensionId } = app;
  const to = args.agentId;
  // Checked where the call is read (`dispatchCallOf`); a built-in App names its own.
  const how: AppMessageOptions = { ...(args.delivery ? { delivery: args.delivery } : {}), ...(args.key ? { key: args.key } : {}) };
  const { visibleAgentsForExtension, sessionsElsewhere } = await import('@main/core/extensions/extension-agents');
  const sessionId = (await visibleAgentsForExtension({ scope: reach, extensionId })).get(to);
  if (sessionId) return tellSessionFromApp(app, sessionId, args.text, { ...how, ...options, to });
  if (reach !== 'all-machines') throw new AppSendError('not-found', `${to} is not an agent this App reaches on this computer`);
  const { rows, unreached } = await sessionsElsewhere();
  const row = rows.find(({ session }) => session.agent && `user:${session.agent.userId}` === to);
  if (!row?.deviceId) {
    // not-found 只在每台机器都答了、都没有它的时候说(App 据此删掉它);有一台没读到(离线、没回话、太旧),就说不准 —— failed。
    const tail = unreached.length ? ` (not read: ${unreached.map((machine) => machine.label ?? machine.detail).join(', ')})` : '';
    throw new AppSendError(unreached.length ? 'failed' : 'not-found', `${to} is not an agent on this computer or on your other online computers${tail}`);
  }
  // 那台机器用同一个函数做全部的事(送法、同键):这里只把话和送法交过去。它只认得那条会话,
  // 回来的话里换回 App 叫它的名字(F35)。
  const { otherMachines } = await import('@main/core/sessions/session-family');
  const there = `session:${row.session.conversationId}`;
  return await otherMachines().appMessage(app, row.deviceId, row.session.conversationId, String(args.text ?? ''), how).catch((error: unknown) => {
    // 那台机器报的码是 App 认得的那几个之一就照用(会话在那边被归档了 = not-found,与本机同一个码),其余是 failed。
    const code = (error as { code?: unknown })?.code;
    const same = APP_SEND_CODES.find((known) => known === code) ?? 'failed';
    throw new AppSendError(same, (error instanceof Error ? error.message : String(error)).replaceAll(there, to));
  });
}

/**
 * 另一台机器上的 App(`agents:control:all-machines`,那台机器判过词)给这台机器上的一条会话发消息:与本机 App 同一个
 * 函数,信封写那个 App(名字取它宿主上的清单)。这条会话得是这台机器上一个 agent。
 */
export async function answerAppMessage(caller: RemoteAppCaller, action: AppMessageAction): Promise<AppMessageReceipt> {
  const [sessionId] = action.session_ids;
  const { visibleAgentsForExtension } = await import('@main/core/extensions/extension-agents');
  const agents = await visibleAgentsForExtension({ scope: 'all', extensionId: caller.extensionId });
  if (![...agents.values()].includes(sessionId)) throw new AppSendError('not-found', `session:${sessionId} is not an agent on this machine`);
  const { delivery, key } = action;
  return tellSessionFromApp(caller, sessionId, action.text, { delivery, key, to: `session:${sessionId}` });
}
