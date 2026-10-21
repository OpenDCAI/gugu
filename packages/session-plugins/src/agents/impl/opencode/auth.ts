import type { AgentAuthContext, AgentAuthStatus } from '@gugu/session-core/agents/plugins';
import {
  opencodeFamilyAuthStatus,
  opencodeFamilyModelCredential,
} from '../../helpers/opencode-family-credential';

// env 名单是家族共性(fork 认同一批变量),钉在家族 helper 里 —— 这里不重抄。
const familyAuthStatus = opencodeFamilyAuthStatus();

export async function opencodeAuthStatus(ctx: AgentAuthContext): Promise<AgentAuthStatus> {
  return familyAuthStatus(ctx);
}

/**
 * 「自家默认模型有没有凭据」(#4956 默认预选规则)。opencode 无独立数据根变量
 * (`OPENCODE_HOME` 不在 agent-env 白名单里,引擎子进程看不到),所以不设 homeEnvVar guard。
 */
export const opencodeModelCredential = opencodeFamilyModelCredential({
  dataDirName: 'opencode',
  configFileBase: 'opencode',
});
