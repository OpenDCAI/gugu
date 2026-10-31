import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

export const CODEX_PERMISSION_MODES = {
  'read-only': { id: ':read-only' },
  edit: { id: ':workspace' },
  'full-access': { id: ':danger-full-access' },
} satisfies ProviderPermissionModeMap;

export type CodexPermissionMode = 'read-only' | 'edit' | 'full-access';

export const CODEX_AUTONOMY_BY_MODE: Record<
  CodexPermissionMode,
  { approvalPolicy: 'never' | 'on-request'; sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access' }
> = {
  // Codex CLI 0.147.0 measurement: this native profile rejects a workspace write with a visible
  // `operation not permitted` command error instead of silently claiming success.
  'read-only': { approvalPolicy: 'never', sandboxMode: 'read-only' },
  edit: { approvalPolicy: 'on-request', sandboxMode: 'workspace-write' },
  'full-access': { approvalPolicy: 'never', sandboxMode: 'danger-full-access' },
};
