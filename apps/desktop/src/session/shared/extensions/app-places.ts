import type { ChatItem } from '@gugu/core/shared/types/chat';
import { HERE_ALL, type EnablePlace } from './host-actions';
import type { ExtensionManifest } from './manifest';

/** A chat as the chat list holds it, as much as 「给哪些 agent」 draws: main reads these columns, the phone has them. */
export type PlaceChat = Pick<ChatItem, 'id' | 'kind' | 'status' | 'name' | 'avatar' | 'member_user_ids' | 'last_message_at' | 'source_chat_id' | 'peer_user_id'>;
/** Who a member is, as the identity directory says; `agentOf`: the person an agent belongs to. */
export type PlaceIdentity = { display_name: string; avatar?: string | null; agentOf?: string | null };

/**
 * D-30 (主人 10-02 方案 A, 125 10-06 the fifth): the places an App's agent tools can be given at, drawn as the chat list
 * draws them — the one answer for main (the desktop) and the phone (its chat list):
 * - this computer's agents (all of them) first when `here` (only the desktop has them);
 * - the person's own agents, each by its private chat with them (`me`'s agents), shown as the agent: its face, its name;
 * - each active group: its picture and members' faces, how many are in it, when it last spoke, and the names of the
 *   topics grown out of it (`source_chat_id`), so a topic's name finds it.
 */
export function placesOfChats(
  chats: readonly PlaceChat[],
  identities: Readonly<Record<string, PlaceIdentity | undefined>>,
  options: { me: string; enabled: ReadonlySet<string>; projects?: ReadonlySet<string>; here?: boolean },
): EnablePlace[] {
  const topics = new Map<string, string[]>();
  for (const chat of chats) {
    if (chat.kind === 'topic' && chat.source_chat_id) topics.set(chat.source_chat_id, [...(topics.get(chat.source_chat_id) ?? []), chat.name]);
  }
  const here: EnablePlace[] = options.here
    ? [{ id: HERE_ALL, kind: 'here' as const, enabled: options.enabled.has(HERE_ALL) }]
    : [];
  const active = chats.filter((chat) => chat.status === 'active');
  const agents = active.flatMap((chat): EnablePlace[] => {
    if (chat.kind !== 'dm') return [];
    const peer = chat.peer_user_id ?? (chat.member_user_ids ?? []).find((id) => id !== options.me);
    const who = peer ? identities[peer] : undefined;
    if (!peer || !who || who.agentOf !== options.me) return [];
    return [{ id: chat.id, kind: 'agent', agentId: peer, name: who.display_name, avatar: who.avatar ?? null, enabled: options.enabled.has(chat.id), lastAt: chat.last_message_at ?? null }];
  });
  const groups = active
    .filter((chat) => chat.kind === 'group')
    .map((chat): EnablePlace => ({
      id: chat.id,
      kind: 'group',
      name: chat.name,
      project: options.projects?.has(chat.id) ?? false,
      enabled: options.enabled.has(chat.id),
      avatar: chat.avatar ?? null,
      members: (chat.member_user_ids ?? [])
        .flatMap((id) => {
          const who = identities[id];
          return who ? [{ id, name: who.display_name, avatar: who.avatar ?? null }] : [];
        })
        .slice(0, GROUP_FACES),
      memberCount: chat.member_user_ids?.length ?? 0,
      lastAt: chat.last_message_at ?? null,
      topics: topics.get(chat.id) ?? [],
    }));
  return [...here, ...agents, ...groups];
}

/** As many faces as a group's picture shows (`Avatar`'s composite). */
export const GROUP_FACES = 9;

/** One place switched on or off. */
export interface PlaceChange {
  id: string;
  on: boolean;
}

/**
 * An App whose tools reach agents: what 「给哪些 agent」 is about. One that gives none is never asked (125 10-05) —
 * Computer Use among them (#7317): its program only answers its own page, and it brings no skills.
 */
export const givesAgentTools = (manifest: Pick<ExtensionManifest, 'permissions'> & { contributes?: Pick<ExtensionManifest['contributes'], 'mcpServers' | 'skills'> }): boolean =>
  (manifest.permissions?.capabilities ?? []).includes('agents:tools') && !isComputerUseView(manifest);

/**
 * #7317 Only the switch of gugu's computer control on a computer: its programs all `computer-use`, no skills. It runs no
 * program of its own; the one reading of that, for `givesAgentTools` and the install sheet's sentence.
 */
export const isComputerUseView = (manifest: { contributes?: Pick<ExtensionManifest['contributes'], 'mcpServers' | 'skills'> }): boolean => {
  const servers = manifest.contributes?.mcpServers ?? [];
  return servers.length > 0 && servers.every((server) => 'host' in server && server.host === 'computer-use') && !manifest.contributes?.skills;
};

/**
 * Whether this computer's places give an App to every agent here: `here:all` among them, or none recorded at all (an App
 * installed before anyone chose, or with no identity to record it under — 125 10-06). The one reading of that rule.
 */
export const hereGives = (here: readonly string[] | null): boolean => here === null || here.includes(HERE_ALL);

/** This computer's places, kept with the install; any other place is a chat (an agent's private chat, or a group). */
export const isHerePlace = (id: string): boolean => id === HERE_ALL;
