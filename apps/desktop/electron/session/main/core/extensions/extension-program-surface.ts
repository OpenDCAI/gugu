import type { ChildProcess } from 'node:child_process';
import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { APP_FRAME_MARKER, fileRefOf, isLocal, type FrameToHost, type HostToFrame } from '@shared/extensions/app-runtime-protocol';
import { currentAccountAccessToken } from '@main/core/extensions/account-token';
import type { BridgeCaller } from './extension-bridge';
import { fileSync } from './file-sync';

/**
 * An App's MCP program as a caller of the App (摩擦单 F16, 真源 §4): the same `gugu` a page has but for a page's own
 * verbs, reached over the child's IPC channel (`gugu-program.mjs`, L3) and answered by the bridge as every page is
 * (`answerCall`) — its file sync traffic on the relay every page uses, under a page id of its own (negative: never a
 * webContents id).
 *
 * A program sits nowhere: like every page, it names where each file is (真源原则 13). The chat files it may open
 * without a capability are the ones handed to the call a verb is made in: a tool parameter with `format: "gugu-file"`,
 * checked as the calling agent at the gateway. With `files:read` / `:write` it lists, opens, creates, renames and
 * removes any other, as a page does — as the agent, in a chat the call handed it (`format: "gugu-chat"`, A1) or the
 * chat of a file it handed it (G5). When the call ends, what it opened as the agent either way ends with it.
 *
 * Which call a verb is made in, the verb says itself (`call`, minted by main for that call and carried by the program's
 * runtime: program-call.ts): one program serves every session here, and two agents' calls may run in it at once, on the
 * same file or chat. A verb is answered as its own call's agent; a verb made in no call (a timer, a file's change) as the
 * App's own page, by the capability words.
 */

/** A group file an agent handed a program in one call: which, in which group, by which agent. */
export interface ExtensionHandedFile {
  itemId: string;
  chatId: string;
  agentUserId: string;
}

/** A1 A chat an agent handed a program in one call (`format: "gugu-chat"`): the agent is in it, checked at the gateway. */
export interface ExtensionHandedChat {
  chatId: string;
  agentUserId: string;
}

export interface ProgramSurface {
  readonly pageId: number;
  /**
   * One call (`callId`, the id its verbs carry): its agent (a bare uuid; null when gugu does not know it), and the files
   * and chats it handed; the function it returns takes them back when that call ends — resolved once the program let go
   * of the files, its last writes handed to the file service ahead of its Close (F106).
   */
  hand(callId: string, agent: string | null, files: readonly ExtensionHandedFile[], chats?: readonly ExtensionHandedChat[]): () => Promise<void>;
  /** How many files it holds open: a program holding one is not idle. */
  openFiles(): number;
  close(): void;
}

let lastPageId = 0;

export function attachProgramSurface(extensionId: string, child: ChildProcess): ProgramSurface {
  const pageId = --lastPageId;
  /** Each call running now, by its id: whose it is, and what it handed. */
  const calls = new Map<string, { agent: string | null; files: readonly ExtensionHandedFile[]; chats: readonly ExtensionHandedChat[] }>();
  const post = (frame: HostToFrame) => {
    if (child.connected) child.send(frame);
  };
  const page = fileSync.attachPort(pageId, extensionId, {
    post: (data) => post({ m: APP_FRAME_MARKER, t: 'sync', data }),
    close: () => {},
  });

  // A file the verb's own call handed it, named by its id: no capability, read and written as the agent that handed it
  // (this person's own, checked at the gateway) — the person may not be in that chat, and what the program writes there
  // is the agent's doing. In a chat that call handed it (A1), or the chat of a file it handed it (G5), what it lists,
  // makes, renames and removes is that agent's too, judged by the agent's membership. Anything else — and every verb made
  // in no call: as a page, by the capability words.
  const filePage = (args: Record<string, unknown>, callId: string | undefined) => {
    const call = callId === undefined ? undefined : calls.get(callId);
    const ref = args.ref === undefined ? null : fileRefOf(args.ref);
    if (call && ref && 'id' in ref && !isLocal(ref)) {
      const given = call.files.find((file) => file.itemId === ref.id);
      if (given) return { pageId, extensionId, handed: { chat: given.chatId, id: given.itemId }, asAgent: given.agentUserId };
    }
    const place = !ref && args.place && typeof args.place === 'object' ? (args.place as { chat?: unknown }) : null;
    const chat = ref && 'chat' in ref ? ref.chat : place?.chat;
    const given = call && typeof chat === 'string' ? [...call.files, ...call.chats].find((handed) => handed.chatId === chat) : undefined;
    return given ? { pageId, extensionId, handed: null, asAgent: given.agentUserId } : { pageId, extensionId, handed: null };
  };
  const callerFor = (callId: string | undefined): BridgeCaller => ({
    extensionId,
    kind: 'program',
    binding: null,
    pageId,
    filePage: (args) => filePage(args, callId),
    hear: (event) => post({ m: APP_FRAME_MARKER, t: 'event', event }),
    // Only an agent's call is stamped with an id (`gugu/call`): a person's page calling the program is not.
    ...(callId === undefined ? {} : { callingAgent: calls.get(callId)?.agent ?? null }),
  });

  const onMessage = (message: unknown) => {
    const frame = message as FrameToHost | null;
    if (frame?.m !== APP_FRAME_MARKER) return;
    if (frame.t === 'sync') {
      fileSync.fromPort(page, frame.data);
      return;
    }
    if (frame.t !== 'call') return;
    // Imported when called: the bridge reaches the programs (`extensionPrograms`), which reach this file.
    void import('./extension-bridge')
      .then(({ answerCall }) => answerCall(callerFor(typeof frame.call === 'string' ? frame.call : undefined), frame.method, (frame.args ?? {}) as Record<string, unknown>))
      .then((answer) =>
        post(
          answer.ok
            ? { m: APP_FRAME_MARKER, t: 'result', id: frame.id, ok: true, value: answer.value ?? null }
            : { m: APP_FRAME_MARKER, t: 'result', id: frame.id, ok: false, code: answer.code, message: answer.message, ...(answer.detail ? { detail: answer.detail } : {}) },
        ),
      );
  };
  child.on('message', onMessage);

  return {
    pageId,
    hand(callId, agent, files, chats = []) {
      calls.set(callId, { agent, files, chats });
      return async () => {
        calls.delete(callId);
        // The call is over: whatever the program opened as its agent goes too — the program closes it itself, its last
        // writes first (F106). A file it was handed, unless another call running now hands it as the same agent; one it
        // opened by the capability words in a chat the call handed it (A1, G5), unless that agent has another call running
        // now. Kept open past its call, it would go on writing as the agent, in a chat the person may not be in.
        const running = [...calls.values()];
        const letGo = files.filter((file) => !running.some((call) => call.files.some((other) => other.itemId === file.itemId && other.agentUserId === file.agentUserId)));
        const done = new Set([...files, ...chats].map((given) => given.agentUserId));
        for (const call of running) for (const given of [...call.files, ...call.chats]) done.delete(given.agentUserId);
        if (letGo.length === 0 && done.size === 0) return;
        await fileSync.revoke(pageId, 'unbound', (grant) =>
          grant.needs === null
            ? letGo.some((file) => file.itemId === grant.itemId && file.agentUserId === grant.asAgent)
            : grant.asAgent !== undefined && done.has(grant.asAgent),
        );
      };
    },
    openFiles: () => fileSync.openCount(pageId),
    close() {
      child.off('message', onMessage);
      fileSync.pageGone(pageId);
      void import('./extension-bridge').then(({ stopPageWatches }) => stopPageWatches(pageId));
    },
  };
}

/** The person's token as a client of the chat schema: every agent read below acts as their agent with it. */
async function signedInChatClient(what: string) {
  const token = await currentAccountAccessToken();
  if (!token || !userIdFromSupabaseAccessToken(token)) throw new Error(`Not signed in, so no ${what} can be handed over`);
  return createGuguSupabaseClient({ schema: 'chat', headers: { Authorization: `Bearer ${token}` } });
}

/**
 * A1 Each handed chat as its id, read as the calling agent: one named by the number people see (its public id) goes to
 * its id, the way the agent's message tools take either; the agent must be in it — the door every agent write of the
 * workspace goes through (`workspace_status_as`). Not there and not the agent's read the same, refused by name.
 */
export async function handedChatsAs(agentUserId: string, chatIds: readonly string[]): Promise<ExtensionHandedChat[]> {
  const client = await signedInChatClient('chat');
  return Promise.all(
    chatIds.map(async (named) => {
      const refusal = new Error(`${named}: not a chat you are in, so it was not handed over`);
      let chatId = named.trim();
      if (/^\d+$/.test(chatId)) {
        const { data } = await client.from('chats').select('id').eq('public_id', chatId);
        const rows = (data as { id: string }[] | null) ?? [];
        if (rows.length !== 1) throw refusal;
        chatId = rows[0]!.id;
      }
      const { error } = await client.rpc('workspace_status_as', { p_chat_id: chatId, p_as_user_id: agentUserId });
      if (error) throw refusal;
      return { chatId, agentUserId };
    }),
  );
}

/**
 * Which group each handed file is in, read as the calling agent: with the person's token acting as their agent, as
 * every agent read of the workspace is (`workspace_get_as`). A file the agent cannot open is refused by name.
 */
export async function handedFilesAs(agentUserId: string, itemIds: readonly string[]): Promise<ExtensionHandedFile[]> {
  const client = await signedInChatClient('chat file');
  return Promise.all(
    itemIds.map(async (itemId) => {
      const { data, error } = await client.rpc('workspace_get_as', { p_item_id: itemId, p_as_user_id: agentUserId });
      const row = (Array.isArray(data) ? data[0] : data) as { chat_id?: string } | null;
      if (error || !row?.chat_id) throw new Error(`${itemId}: not a chat file you can open, so it was not handed over`);
      return { itemId, chatId: row.chat_id, agentUserId };
    }),
  );
}
