/**
 * advertised-command-provider — resolves slash-command tokens for chat-ui.
 *
 * Each ACP conversation registers a getter that returns its current advertised
 * command names.  The singleton `AdvertisedCommandProvider` resolves tokens
 * against the set registered for the given conversation URI, so only commands
 * the agent actually advertises become chips in the transcript.
 *
 * Usage (from AcpChatStore):
 *   registerSessionCommands(conversationId, () => this.commands.map(c => c.name));
 *   // on dispose:
 *   unregisterSessionCommands(conversationId);
 */

import type { ChatCommandMeta, CommandProvider } from '@gugu/session-chat-ui';

/** Module-level registry: conversationId → live command-name getter. */
const registry = new Map<string, () => string[]>();

export function registerSessionCommands(uri: string, getNames: () => string[]): void {
  registry.set(uri, getNames);
}

export function unregisterSessionCommands(uri: string): void {
  registry.delete(uri);
}

/**
 * Singleton CommandProvider that resolves tokens only when the uri is
 * registered and the token is in that conversation's advertised command names.
 */
export const advertisedCommandProvider: CommandProvider = {
  resolve(token: string, uri?: string): ChatCommandMeta | null {
    if (!uri) return null;
    const getNames = registry.get(uri);
    if (!getNames) return null;
    const names = getNames();
    if (!names.includes(token)) return null;
    return { name: token };
  },
};
