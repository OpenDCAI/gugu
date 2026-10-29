import type { AskSource } from '@gugu/session-core/session-record/contract';
import type { AgentWaitKind } from '@gugu/core/shared/agentStatus';
import { INSTALL_CONSENT_HUMAN_WINDOW_MS } from '@shared/extensions/host-actions';
import { APP_HUMAN_TIMEOUT_MS } from '@shared/extensions/app-human';
export type AskSourceSpec = { waitKind: AgentWaitKind; raisedBy: 'runtime' | 'host'; timeoutMs?: number };
export const ASK_SOURCE_SPEC = {
  'harness-permission': { waitKind: 'approval', raisedBy: 'runtime' },
  'harness-question': { waitKind: 'question', raisedBy: 'runtime' },
  'agent-question': { waitKind: 'question', raisedBy: 'host' },
  'app-install': { waitKind: 'approval', raisedBy: 'host', timeoutMs: INSTALL_CONSENT_HUMAN_WINDOW_MS },
  'app-human': { waitKind: 'approval', raisedBy: 'host', timeoutMs: APP_HUMAN_TIMEOUT_MS },
} as const satisfies Record<AskSource, AskSourceSpec>;

/** Archived records may name a source removed in a later release. */
export function askSourceSpec(source: string): AskSourceSpec | undefined {
  return Object.hasOwn(ASK_SOURCE_SPEC, source) ? ASK_SOURCE_SPEC[source as AskSource] : undefined;
}
