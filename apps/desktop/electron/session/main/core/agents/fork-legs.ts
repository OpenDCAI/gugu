import type { CLIAgentPluginProvider } from '@gugu/session-core/agents/plugins';
import type { SessionRuntime } from '@shared/core/sessions/sessions';
import { agentCapabilitiesChangedChannel } from '@shared/core/agents/agentEvents';
import { KV } from '@main/db/kv';
import { events } from '@main/lib/events';

/**
 * What each provider's last ACP `initialize` on this machine said about `sessionCapabilities.fork`.
 * Kept in the local kv: a restart is not a new adapter, and no adapter runs again until a session
 * next needs one. A provider that has never handshaken here has no entry.
 */
const store = new KV<Record<string, boolean>>('acp-fork-handshakes');
const acpForkHandshakes = new Map<string, boolean>();

/** Read once at startup; every fork gate reads memory synchronously. */
export async function loadAcpForkHandshakes(): Promise<void> {
  for (const [providerId, fork] of Object.entries(await store.getAll())) acpForkHandshakes.set(providerId, fork as boolean);
}

/** Fed by the ACP runtime on every acquired connection; renderers re-read agents when a reading changes. */
export function recordAcpForkHandshake(providerId: string, fork: boolean): void {
  if (acpForkHandshakes.get(providerId) === fork) return;
  acpForkHandshakes.set(providerId, fork);
  void store.set(providerId, fork);
  events.emit(agentCapabilitiesChangedChannel, { providerId });
}

/**
 * The runtimes this provider can fork on — the one rule every fork entry and the main-process gate read.
 *
 * · `pty`: no handshake exists on the terminal leg, so only the plugin table can say (`sessions.fork`).
 * · `acp`: a provider-owned fork hook decides when there is one (claude `forkViaNewSessionMeta`,
 *   opencode `resolveForkSource`, antigravity `forkSessionInStorage` — their adapters' own
 *   `session/fork` is not the path Gugu takes). Otherwise the adapter's own `initialize` decides
 *   (codex, oh-my-pi, pi …), so an adapter upgrade that adds `session/fork` shows the entry with no
 *   product change, and the next connection corrects a stale reading. Never handshaken on this
 *   machine ⇒ not offered.
 */
export function forkRuntimes(provider: CLIAgentPluginProvider): SessionRuntime[] {
  const runtimes: SessionRuntime[] = [];
  if (provider.capabilities.sessions.fork === 'supported') runtimes.push('pty');
  const acp = provider.behavior.acp;
  const hooked = Boolean(acp?.forkViaNewSessionMeta || acp?.resolveForkSource || acp?.forkSessionInStorage);
  if (hooked || acpForkHandshakes.get(provider.metadata.id) === true) runtimes.push('acp');
  return runtimes;
}

export function resetAcpForkHandshakesForTest(): void {
  acpForkHandshakes.clear();
}
