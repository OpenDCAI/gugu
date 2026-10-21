import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

export const CLAUDE_PERMISSION_MODES = {
  plan: { id: 'plan' },
  'read-only': { id: 'default', aliases: ['dontAsk'] },
  edit: { id: 'acceptEdits' },
  'full-access': { id: 'bypassPermissions' },
} satisfies ProviderPermissionModeMap;
