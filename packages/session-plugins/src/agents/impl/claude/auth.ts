import type { AgentAuthContext, AgentAuthStatus } from '@gugu/session-core/agents/plugins';
import { authenticatedFromEnv } from '../../helpers/auth';

const AUTH_STATUS_TIMEOUT_MS = 5_000;
const LOGGED_OUT_PATTERN = /not (authenticated|logged in|signed in)|login required|logged out/i;

type ExecErrorWithOutput = {
  code?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  message?: unknown;
};

export async function claudeAuthStatus(ctx: AgentAuthContext): Promise<AgentAuthStatus> {
  const envStatus = authenticatedFromEnv(ctx, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  if (envStatus.kind === 'authenticated') return { ...envStatus, credentialKind: 'api-key' };

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
