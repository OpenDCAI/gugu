import type { AskSource } from '@gugu/session-core/session-record/contract';
import type { AgentWaitKind } from '@gugu/core/shared/agentStatus';
export type AskSourceSpec = { waitKind: AgentWaitKind; raisedBy: 'runtime' | 'host'; timeoutMs?: number };
export const ASK_SOURCE_SPEC = {
  'harness-permission': { waitKind: 'approval', raisedBy: 'runtime' },
  'harness-question': { waitKind: 'question', raisedBy: 'runtime' },
  'agent-question': { waitKind: 'question', raisedBy: 'host' },
  'app-install': { waitKind: 'approval', raisedBy: 'host' },
  'browser-assistance': { waitKind: 'dialog', raisedBy: 'host', timeoutMs: 600_000 },
} as const satisfies Record<AskSource, AskSourceSpec>;
