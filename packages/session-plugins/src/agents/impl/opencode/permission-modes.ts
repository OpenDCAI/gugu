import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

export const OPENCODE_PERMISSION_MODES = {
  plan: { id: 'plan' },
  edit: { id: 'build' },
} satisfies ProviderPermissionModeMap;
