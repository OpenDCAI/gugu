import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { buildExtensionEnvelope, formatDeliveryTimestamp } from '@gugu/core/local/agent/deliveryEnvelope';
import { extensionsService } from '@main/core/extensions/extensions-root';
import { currentAccountAccessToken } from '@main/core/extensions/account-token';
import { ABOUT_GONE, AppSendError, COMPOSE_WHERE, composeInChat, createAppSend } from '@shared/extensions/app-send-core';
import { createAppMessages } from '@shared/extensions/app-messages-core';
import { createAppForum, type ForumChannel } from '@shared/extensions/app-forum-core';
import { subscribeStatusName } from '@gugu/core/cloud/deviceRpcProtocol';
import { log } from '@main/lib/logger';
import { supabase } from '../../../../supabase';
import { subscribeAuthenticatedElectronRealtimeChannel, type ElectronManagedRealtimeChannel } from '../../../../realtime-channel';
import type { AppMessageAction, AppMessageOptions, AppMessageReceipt, RemoteAppCaller } from '@gugu/session-core/session-record/contract';
import type { AppComposeDetail } from '@shared/extensions/app-runtime-protocol';

/** The codes an App reads off a failed send — the same whether the agent is here or on another computer. */
const APP_SEND_CODES = ['denied', 'invalid', 'not-found', 'rate-limited', 'failed'] as const satisfies readonly AppSendError['code'][];

/**
 * How an App tells someone, on the desktop — two verbs, as an agent's two tools are (真源 §4 F16): `gugu.send`, a whisper
 * in the chat the call names (`message_send`'s act; the shared answer, `app-send-core.ts`, the phone's too), and
 * `gugu.messageAgent`, one of the person's own agents here, told as `session_message` tells it. Neither reads where the
 * page is (真源原则 13).
 */

export { AppSendError };

async function account(): Promise<{ token: string; userId: string }> {
  const token = await currentAccountAccessToken();
  const userId = token ? userIdFromSupabaseAccessToken(token) : null;
  if (!token || !userId) throw new AppSendError('failed', 'Not signed in');
  return { token, userId };
}

/** `gugu.send`: a whisper in the chat the call names. */
export const sendFromApp = createAppSend({ account });

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
    const { token } = await account();
    const unsubscribe = await subscribeAuthenticatedElectronRealtimeChannel(
      { realtime: supabase.realtime, removeChannel: (channel) => supabase.removeChannel(channel as never) },
      create(),
      {
        accessToken: token,
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

/**
 * `gugu.compose(text, { chat } | { session } | { refs })` on the desktop: whose composer, and what goes in. A chat's (or
 * the chat of the files its refs point at): `composeInChat`, the phone's answer too. A session on this computer: its agent's.
 */
export async function composeTarget(args: {
  text: unknown;
  chat?: unknown;
  session?: unknown;
  refs?: unknown;
  about?: unknown;
  images?: unknown;
}): Promise<AppComposeDetail | { session: { id: string; projectId: string }; text: string }> {
  if (args.session === undefined || args.session === null) return composeInChat({ account }, args);
  if (args.about !== undefined && args.about !== null) throw new AppSendError('invalid', ABOUT_GONE);
  // A session's composer takes words only: pills point at a chat's files (App 引用 pill), and go into that chat's.
  if ((args.chat !== undefined && args.chat !== null) || (args.refs !== undefined && args.refs !== null)) {
    throw new AppSendError('invalid', COMPOSE_WHERE);
  }
  if (args.images !== undefined && args.images !== null) throw new AppSendError('invalid', 'images go into a chat\'s composer: { chat } or { refs }, not a session\'s');
  const text = String(args.text ?? '').trim();
  if (!text) throw new AppSendError('invalid', 'Nothing to compose: text is empty');
  const sessionId = typeof args.session === 'string' ? args.session : '';
  const { agentSessionContext } = await import('@main/core/extensions/extension-agent-context');
  const facts = sessionId ? await agentSessionContext(sessionId) : null;
  if (!facts?.projectId) throw new AppSendError('not-found', `No session ${sessionId} on this computer`);
  return { session: { id: sessionId, projectId: facts.projectId }, text: `${text}\n` };
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
 * `gugu.messageAgent(agentId, text)`: `agentId` (`user:<uuid>`, as `listAgents` gives it) is one of the agents this App
 * reaches — `agents:control` the ones it started, `:all` every one here, `:all-machines` also every one on the person's
 * other online computers (found in the same task lists `listAgents` reads). The door asked for `agents:control`. `from`:
 * the session of the agent that works the page (owner 10-14) — it is the one telling, so not itself.
 */
export async function messageAgentFromApp(
  extensionId: string,
  args: { agentId: unknown; text: unknown; queue?: unknown; defer?: unknown; key?: unknown },
  options: { from?: string } = {},
): Promise<AppMessageReceipt> {
  const to = String(args.agentId ?? '');
  if (args.queue !== undefined && typeof args.queue !== 'boolean') throw new AppSendError('invalid', 'queue is true or false');
  if (args.defer !== undefined && typeof args.defer !== 'boolean') throw new AppSendError('invalid', 'defer is true or false');
  if (args.queue === true && args.defer === true) throw new AppSendError('invalid', 'queue or defer, not both');
  if (args.key !== undefined && (typeof args.key !== 'string' || !args.key)) throw new AppSendError('invalid', 'key is a non-empty string');
  const how: AppMessageOptions = {
    ...(args.queue === true ? { delivery: 'queue' as const } : {}),
    ...(args.defer === true ? { delivery: 'defer' as const } : {}),
    ...(typeof args.key === 'string' ? { key: args.key } : {}),
  };
  const { visibleAgentsForExtension, sessionsElsewhere } = await import('@main/core/extensions/extension-agents');
  const reach = extensionsService().agentReach(extensionId, 'agents:control');
  const app = { extensionId, extensionName: extensionsService().get(extensionId).manifest.name };
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
