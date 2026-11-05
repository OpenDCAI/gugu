import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

/**
 * dsh 的三个权限预设(`dsh-base` 的 `permission` 行:read-only / workspace-write / danger-full-access,
 * 前两档 approval=ask,最后一档 never)。它没有规划档,❌ 不声明 `plan`。
 * 这张表也是物化器写 `DSH_PERMISSION_MODE` 的唯一来源(./session-bundle.ts)。
 */
export const DSH_PERMISSION_MODES = {
  'read-only': { id: 'read-only' },
  edit: { id: 'workspace-write' },
  'full-access': { id: 'danger-full-access' },
} satisfies ProviderPermissionModeMap;
