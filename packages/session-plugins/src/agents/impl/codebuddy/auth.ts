import type { AgentAuthContext, AgentAuthStatus } from '@gugu/session-core/agents/plugins';

/**
 * CodeBuddy Code 的登录 —— **协议登录**(与 antigravity 同一种):CLI 没有登录子命令
 * (`codebuddy --help` 2.169.0 的子命令表里没有 login),TUI 里是 `/login`;未登录时 ACP
 * `session/new` 回 `-32000 Authentication required`(实测 A),`initialize.authMethods` 自报
 * `iOA` / `external` / `internal` / `selfhosted`。咕咕替它发 `authenticate {methodId}`,
 * 它自己拉起浏览器完成登录(`dist/codebuddy.js` 的 `authenticate()`:`authManager.login({type})`)。
 *
 * 只摆两种个人账号入口:国际版(`external`,Google / GitHub,www.codebuddy.ai)与中国版
 * (`internal`,微信,copilot.tencent.com)。iOA(腾讯内网)与私有化(selfhosted)是企业入口,
 * 由用户在 CodeBuddy 自己的配置里选定,咕咕照原样带进去,❌ 不为它们造入口。
 */
export const CODEBUDDY_INTERNATIONAL_LOGIN_METHOD_ID = 'codebuddy-international';
export const CODEBUDDY_CHINA_LOGIN_METHOD_ID = 'codebuddy-china';
export const CODEBUDDY_ACP_INTERNATIONAL = 'external';
export const CODEBUDDY_ACP_CHINA = 'internal';

/** 官方文档 https://www.codebuddy.ai/docs/cli/iam:两种凭据都是环境变量。 */
const CODEBUDDY_CREDENTIAL_ENVS = ['CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_API_KEY'] as const;

/**
 * 「登没登 CodeBuddy 账号」。
 *
 * · 环境里有 `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_API_KEY` → `authenticated`(IAM 文档的三种凭据里
 *   这两种由环境直接给出,有它就一定走得通)。
 * · 其余一律 `unknown`,❌ 不报 `unauthenticated`:浏览器登录后的会话由它自己的 auth manager 保管,
 *   咕咕没有能判死「没登录」的一手判据。真读数是 ACP 探针(`harness-model-catalog`)真起一次会话、
 *   被拒才记 `auth-required`。
 */
export async function codebuddyAuthStatus(ctx: AgentAuthContext): Promise<AgentAuthStatus> {
  if (CODEBUDDY_CREDENTIAL_ENVS.some((name) => ctx.env?.[name]?.trim())) {
    return { kind: 'authenticated', credentialKind: 'api-key' };
  }
  return {
    kind: 'unknown',
    message: '登录凭据由 CodeBuddy 自行保存，咕咕无法读取登录状态。',
  };
}
