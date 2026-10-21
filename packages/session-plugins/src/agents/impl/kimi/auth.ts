import type { AgentAuthContext, AgentAuthStatus } from '@gugu/session-core/agents/plugins';
import { parse as parseTOML } from 'smol-toml';
import { KIMI_CONFIG_PATH } from './hooks';
import { KIMI_HOME_ENV } from './session-bundle';

/**
 * Kimi Code 的登录方式 —— **一手出处**:`MoonshotAI/kimi-code`
 * @`b17bd61cefba3ea0aef5c61d5cd1085c8cfde065`。
 *
 *  · 子命令本体:`apps/kimi-code/src/cli/sub/login.ts:13-25` ——
 *    `.command('login').description('Authenticate with Kimi Code CLI via the device-code flow.')`;
 *  · 流程本体:`apps/kimi-code/src/cli/sub/login-flow.ts:44-69` —— RFC 8628 设备码。它**先**把
 *    `Opening browser for Kimi device login: <url>` 与 `…enter code: <userCode>` 打到 stderr,
 *    **再**去尝试开浏览器(源码原文注释:「so headless/browser-opener failures never hide the URL」)。
 *    ⇒ 这条命令在咕咕那个内嵌终端里是**自足**的:URL 与用户码都会印出来,
 *    而登录运行时的 URL 探测(`agent-config/runtime/auth.ts` 的 `detectUrl`)正好据此给出「打开链接」。
 *  · 文档同源:`docs/en/reference/kimi-command.md:136-146`。
 *
 * ⚠️ 方法名逐字用它 ACP 自报的那句 `Login with Kimi account`
 *   (`packages/acp-adapter/src/auth-methods.ts:37-46`)—— 用户在 composer 那句
 *   「Kimi 需要先登录(Login with Kimi account)」里看到的就是它,两处对不上等于让人以为是两件事。
 */
export const KIMI_LOGIN_METHOD_ID = 'kimi-login';

/**
 * 一次成功的 `kimi login` 会把 oauth ref 写进 `config.toml` 的
 * `providers."managed:kimi-code".oauth` —— 判据不是我们发明的,是 Kimi 自己判「上次登录过没有」
 * 用的那一条:`apps/kimi-code/src/utils/region.ts:29,44-50`(`persistedKimiOAuthRef()` 原文
 * `result.config.providers?.['managed:kimi-code']?.oauth`)。
 */
const KIMI_MANAGED_OAUTH_PROVIDER_KEY = 'managed:kimi-code';

/**
 * 「登没登 Kimi 账号」。
 *
 * ⚠️ 三个分支各有各的理由,❌ 别把后两个合并成 `unauthenticated`:
 *
 *  · **有 oauth ref → authenticated**。见上,与厂商自己的判据同一条。
 *  · **整份 config.toml 都不存在 → unauthenticated**。这台机器上从没配过 Kimi ——
 *    这是唯一一种「查不到」等于「真没有」的情形。
 *  · **config 在、但没有 oauth ref → unknown**。Kimi 的凭据**不只**走 OAuth:官方文档
 *    `docs/en/configuration/env-vars.md:5-6` 明写 `KIMI_API_KEY` / `ANTHROPIC_API_KEY` /
 *    `OPENAI_API_KEY` 这类**不从环境变量读**、必须写进 `config.toml`。
 *    照「没有 oauth ref 就是没登录」判,会把一个用 API key 配好、跑得好好的用户恒定误报成未登录 ——
 *    那正是 qwen 那条注释警告的「一个恒定误报的判据比没有判据更坏」。
 *
 * ⚠️ `KIMI_CODE_HOME` 指向手上这把 fs **照不到**的地方时判 `unknown`:各家的登录判据都是
 *    **home 相对**的读法,数据根被挪走时读到的那份**不是同一份**文件。
 *    ❌ 不拿一个读错位置的读数去断言登录态。
 *
 *    判「照不照得到」看 `ctx.fsFollowsConfigRoot`,**不是**看变量设没设:
 *     · 走**独立 home**(2026-08-28 起,见 session-bundle.ts 的 `configRoot`)时这个变量是
 *       **咕咕自己设的**,而 fs 正锚在它的影子 home 上 —— 同一处,照常判。只看「设没设」
 *       会让这一家的登录态从独立 home 上线那天起**永久** `unknown`。
 *     · 剩下的触发者只有一个:**用户自己**把 home 挪走了(`KIMI_CODE_HOME` 在
 *       透传白名单里 —— kimi 的 `shellEnv.passThrough`,所以他 export 的那份到得了 `ctx.env`)。
 */
export async function kimiAuthStatus(ctx: AgentAuthContext): Promise<AgentAuthStatus> {
  const relocatedHome = ctx.env?.[KIMI_HOME_ENV]?.trim();
  // ⚠️ `fsFollowsConfigRoot` 一定要看:走**独立 home** 时这个变量是**咕咕自己设的**,
  //    而手上这把 fs 正锚在它的影子 home 上 —— 两边同一处,照常判。只看「设没设」会把
  //    独立 home 一上线就永久打成 `unknown`。
  if (relocatedHome && !ctx.fsFollowsConfigRoot) {
    return {
      kind: 'unknown',
      message: `${KIMI_HOME_ENV} 指向 ${relocatedHome},咕咕这条 home 相对的读法照不到那份 config.toml。`,
    };
  }

  let content: string | null;
  try {
    content = await ctx.fs.read(KIMI_CONFIG_PATH);
  } catch (error) {
    // 读失败是「不知道」,❌ 不是「没登录」—— 拿失败的仪器当阴性读数。
    return {
      kind: 'unknown',
      message: `无法读取 ${KIMI_CONFIG_PATH}:${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (content === null) {
    return {
      kind: 'unauthenticated',
      message: `还没有 ${KIMI_CONFIG_PATH} —— 这台机器上没跑过 kimi login,也没写过任何凭据。`,
    };
  }

  let parsed: unknown;
  try {
    parsed = parseTOML(content);
  } catch (error) {
    return {
      kind: 'unknown',
      message: `${KIMI_CONFIG_PATH} 解析失败:${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return hasManagedOAuthRef(parsed)
    ? { kind: 'authenticated' }
    : {
        kind: 'unknown',
        message: `${KIMI_CONFIG_PATH} 里没有 OAuth 凭据引用;它也可能配的是写在同一份文件里的 API key,咕咕判不了。`,
      };
}

function hasManagedOAuthRef(config: unknown): boolean {
  if (typeof config !== 'object' || config === null) return false;
  const providers = (config as { providers?: unknown }).providers;
  if (typeof providers !== 'object' || providers === null) return false;
  const managed = (providers as Record<string, unknown>)[KIMI_MANAGED_OAUTH_PROVIDER_KEY];
  if (typeof managed !== 'object' || managed === null) return false;
  const oauth = (managed as { oauth?: unknown }).oauth;
  return typeof oauth === 'object' && oauth !== null;
}
