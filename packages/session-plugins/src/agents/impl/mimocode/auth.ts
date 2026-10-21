import type { AgentAuthContext, AgentAuthStatus } from '@gugu/session-core/agents/plugins';
import {
  opencodeFamilyAuthStatus,
  opencodeFamilyModelCredential,
} from '../../helpers/opencode-family-credential';

/**
 * MiMo Code 是 opencode 的逐字节 fork:`mimo auth list` 的输出与 `opencode auth list` 同形
 * (2026-09-04 本机实测,尾行同为 `N credentials`,凭据落盘 `~/.local/share/mimocode/auth.json`)。
 * 判读复用家族 helper(env 名单也钉在那边 —— 它是家族共性,不是品牌差异);这里只钉品牌差异。
 */
const familyAuthStatus = opencodeFamilyAuthStatus();

export async function mimocodeAuthStatus(ctx: AgentAuthContext): Promise<AgentAuthStatus> {
  return familyAuthStatus(ctx);
}

/**
 * 「自家默认模型有没有凭据」(#4956 默认预选规则)。实测它的默认 `selected` 是
 * `xiaomi/mimo-v2.5-pro-ultraspeed`,provider 前缀 `xiaomi`;数据根可被 `MIMOCODE_HOME`
 * 挪走(agent-env 白名单里),挪走而 fs 不随根走时判 unknown。
 */
export const mimocodeModelCredential = opencodeFamilyModelCredential({
  dataDirName: 'mimocode',
  configFileBase: 'mimocode',
  homeEnvVar: 'MIMOCODE_HOME',
});
