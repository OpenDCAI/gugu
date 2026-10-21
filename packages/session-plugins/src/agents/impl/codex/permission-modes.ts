import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

export const CODEX_PERMISSION_MODES = {
  'read-only': { id: ':read-only' },
  edit: { id: ':workspace' },
  'full-access': { id: ':danger-full-access' },
} satisfies ProviderPermissionModeMap;
