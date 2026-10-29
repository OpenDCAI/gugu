import type { AskSource } from '@gugu/session-core/session-record/contract';
import type { AgentWaitKind } from '@gugu/core/shared/agentStatus';
import { INSTALL_CONSENT_HUMAN_WINDOW_MS } from '@shared/extensions/host-actions';
export type AskSourceSpec = { waitKind: AgentWaitKind; raisedBy: 'runtime' | 'host'; timeoutMs?: number };
export const ASK_SOURCE_SPEC = {
  'harness-permission': { waitKind: 'approval', raisedBy: 'runtime' },
  'harness-question': { waitKind: 'question', raisedBy: 'runtime' },
  'agent-question': { waitKind: 'question', raisedBy: 'host' },
  'app-install': { waitKind: 'approval', raisedBy: 'host', timeoutMs: INSTALL_CONSENT_HUMAN_WINDOW_MS },
} as const satisfies Record<AskSource, AskSourceSpec>;
