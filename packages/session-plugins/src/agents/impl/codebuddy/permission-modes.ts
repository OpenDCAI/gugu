import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

/**
 * ACP `session/new` 自报 8 档(2.169.0 实测 B):default / acceptEdits / plan / auto / dontAsk /
 * bypassPermissions / fullAccess / delegate。前五档的名字与语义同 Claude Code,映射照抄 Claude 那张表。
 * `auto`(分类器判批准)、`fullAccess`、`delegate` 不在「能改多少」这条阶梯上,不声明。
 */
export const CODEBUDDY_PERMISSION_MODES = {
  plan: { id: 'plan' },
  'read-only': { id: 'default', aliases: ['dontAsk'] },
  edit: { id: 'acceptEdits' },
  'full-access': { id: 'bypassPermissions' },
} satisfies ProviderPermissionModeMap;
