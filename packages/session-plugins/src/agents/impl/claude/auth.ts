import type { AgentAuthContext, AgentAuthStatus } from '@gugu/session-core/agents/plugins';
import { authenticatedFromEnv } from '../../helpers/auth';
import { objectAt, readJsonObject } from '../../helpers/subscription';

const AUTH_STATUS_TIMEOUT_MS = 5_000;
const LOGGED_OUT_PATTERN = /not (authenticated|logged in|signed in)|login required|logged out/i;

/**
 * 「用户自己递进来的凭据」的两个环境变量名 —— `ANTHROPIC_API_KEY`(控制台 / 中转给的 key)与
 * `ANTHROPIC_AUTH_TOKEN`(直接被当作 Authorization 头打出去的中转令牌)。
 *
 * ⚠️ `CLAUDE_CODE_OAUTH_TOKEN`(`claude setup-token` 出的订阅长期令牌)**不在其列**:它与
 *    `ANTHROPIC_AUTH_TOKEN` 在 `claude auth status` 里都报 `oauth_token`(2.1.284 实测两台各一次),
 *    但只有后者是「钥匙由谁给的、谁自己管」—— 前者仍然是一份 Anthropic 订阅登录。
 */
const USER_SUPPLIED_CREDENTIAL_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

type ExecErrorWithOutput = {
  code?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  message?: unknown;
};

export async function claudeAuthStatus(ctx: AgentAuthContext): Promise<AgentAuthStatus> {
  const envStatus = authenticatedFromEnv(ctx, USER_SUPPLIED_CREDENTIAL_ENV);
  if (envStatus.kind === 'authenticated') return { ...envStatus, credentialKind: 'api-key' };
  // Claude Code 自己那份 `settings.json` 的 `env` 块**压得住进程环境**(cc-switch 一类中转就把令牌
  // 与中转地址写在那里),所以「这一家此刻拿什么凭据去打上游」在 `ctx.env` 里是看不全的。
  // 漏掉它的后果是**判成订阅登录**:这类用户没有 Anthropic 账号,凭据被拒时那条「登录已失效 · 重新
  // 登录」既说错了原因(#1163:cc-switch 的中转 401 ⇒ 账号行说「登录已失效」、自家的模型清单被换掉),
  // 指的也全是他们没有的那条路。
  const settingsStatus = authenticatedFromEnv(
    { ...ctx, env: await claudeSettingsEnv(ctx) },
    USER_SUPPLIED_CREDENTIAL_ENV
  );
  if (settingsStatus.kind === 'authenticated') return { ...settingsStatus, credentialKind: 'api-key' };

  try {
    const { stdout } = await ctx.exec(ctx.cli, ['auth', 'status'], {
      timeout: AUTH_STATUS_TIMEOUT_MS,
    });
    const status = parseAuthStatus(stdout);
    if (
      status?.loggedIn === false
      && !status.apiKeySource
      && (!status.apiProvider || status.apiProvider === 'firstParty')
    ) {
      return { kind: 'unauthenticated' };
    }
    const credentialKind = credentialKindOf(status);
    return {
      kind: 'authenticated',
      account: accountFromAuthStatus(stdout),
      ...(credentialKind ? { credentialKind } : {}),
    };
  } catch (error) {
    const output = outputFromExecError(error);
    if (isExitCode(error, 1) && isAuthStatusResponse(output)) {
      return { kind: 'unauthenticated' };
    }
    return { kind: 'unknown' };
  }
}

/**
 * Claude Code 自己那份 `settings.json` 的 `env` 块,只留字符串值;读不出 ⇒ 空表。
 *
 * 「读不出」= 没有那个文件 / 解析失败 / 手上这把 fs 照不到这一家的配置根 —— 那是**仪器读数缺席**,
 * 不是「没有凭据」,所以调用方照旧去问 CLI,❌ 不在这里编一个「没登录」出来。
 *
 * ⚠️ 用户自己导出了 `CLAUDE_CONFIG_DIR` 时,手上这把 fs 锚在真 OS home 上,而 Claude Code 读的是
 *    那个变量指的根(见 `AgentAuthContext.fsFollowsConfigRoot` 那格)。两者不是一处时,
 *    `.claude/settings.json` **不是**它会读的那份 —— 读它等于拿另一个账号的配置下结论 ⇒ 不读。
 *    配置根是咕咕自己设的(独立 home / 连接保管目录)时 fs 与它成对,照读。
 */
async function claudeSettingsEnv(ctx: AgentAuthContext): Promise<Record<string, string>> {
  if (!ctx.fsFollowsConfigRoot && ctx.env.CLAUDE_CONFIG_DIR?.trim()) return {};
  const env = objectAt(await readJsonObject(ctx, '.claude/settings.json'), 'env');
  if (!env) return {};
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

/**
 * 这份登录由谁付钱 —— 按 `claude auth status` 的 `authMethod` 判(#7146)。
 *
 * Claude Code 自己只写这几个值:none / third_party / claude.ai / api_key_helper / oauth_token / api_key;
 * `claude.ai` 是订阅登录,`oauth_token` 是 `claude setup-token` 出的长期令牌(同样要订阅)。
 * 带了 `apiKeySource` 的一律按 key 算(与从前同一个先后)。`third_party`(Bedrock / Vertex 等云)
 * 两边都不是,不写 —— ❌ 不猜。
 */
function credentialKindOf(status: Record<string, unknown> | null): 'subscription' | 'api-key' | undefined {
  if (!status) return undefined;
  if (status.apiKeySource) return 'api-key';
  switch (status.authMethod) {
    case 'claude.ai':
    case 'oauth_token':
      return 'subscription';
    case 'api_key':
    case 'api_key_helper':
      return 'api-key';
    default:
      return undefined;
  }
}

function isExitCode(error: unknown, code: number): boolean {
  return (
    typeof error === 'object' && error !== null && (error as ExecErrorWithOutput).code === code
  );
}

function isAuthStatusResponse(output: ExecErrorOutput): boolean {
  if (parseAuthStatus(output.stdout)) return true;
  return LOGGED_OUT_PATTERN.test(output.combined);
}

function accountFromAuthStatus(output: string): string | undefined {
  const status = parseAuthStatus(output);
  const oauthAccount = objectValue(status?.oauthAccount);
  return firstString(
    status?.email,
    status?.account,
    status?.accountEmail,
    oauthAccount?.emailAddress,
    oauthAccount?.email
  );
}

function parseAuthStatus(output: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(output);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type ExecErrorOutput = {
  stdout: string;
  combined: string;
};

function outputFromExecError(error: unknown): ExecErrorOutput {
  if (typeof error !== 'object' || error === null) {
    const message = String(error);
    return { stdout: '', combined: message };
  }
  const withOutput = error as ExecErrorWithOutput;
  const stdout = typeof withOutput.stdout === 'string' ? withOutput.stdout : '';
  const combined = [withOutput.stdout, withOutput.stderr, withOutput.message]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return { stdout, combined };
}
