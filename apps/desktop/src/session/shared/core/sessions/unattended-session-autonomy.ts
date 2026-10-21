import type { GuguPermissionMode } from '@gugu/session-core/acp';

/**
 * Sessions running as Gugu chat members have no person present to answer a permission prompt.
 * Creation paths persist this decision; transports only translate it to harness-specific settings.
 */
export const UNATTENDED_SESSION_PERMISSION_MODE: GuguPermissionMode = 'full-access';
