import type { McpOAuthCredentials } from '@gugu/session-plugins/integrations';
import {
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

// 远程 MCP 服务的浏览器授权里「协议这一半」:发现 → 动态注册客户端 → PKCE → 换令牌。桌面主进程(收回跳的是本机
// 127.0.0.1 的一次性监听)与手机(没有监听,回跳由人把地址贴回来)共用这一份;收回跳、开浏览器各端自己做,
// 所以这里的流程是两段:`beginMcpAuthorization` 给出授权页地址,`complete(code)` 换令牌。
// 这个文件不碰 node:*,手机的网页包能直接带它。

const PROBE_TIMEOUT_MS = 15_000;

export class McpAuthorizationCancelledError extends Error {
  constructor() {
    super('Authorization was cancelled.');
    this.name = 'McpAuthorizationCancelledError';
  }
}

export class HostOAuthProvider implements OAuthClientProvider {
  private client: OAuthClientInformationMixed | undefined;
  private currentTokens: OAuthTokens | undefined;
  private obtainedAt = 0;
  private verifier: string | undefined;

  constructor(
    readonly redirectUrl: string,
    private readonly stateValue: string,
    private readonly onRedirect: (authorizationUrl: URL) => Promise<void>
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Gugu',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.client;
  }

  saveClientInformation(information: OAuthClientInformationMixed): void {
    this.client = information;
  }

  tokens(): OAuthTokens | undefined {
    return this.currentTokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.currentTokens = tokens;
    this.obtainedAt = Date.now();
  }

  redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    return this.onRedirect(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('OAuth code verifier is missing.');
    return this.verifier;
  }

  toCredentials(serverUrl: string, resourceMetadataUrl: URL | undefined): McpOAuthCredentials {
    if (!this.client || !this.currentTokens) {
      throw new Error('Authorization finished without a registered client or tokens.');
    }
    return {
      serverUrl,
      redirectUrl: this.redirectUrl,
      clientInformation: this.client,
      tokens: this.currentTokens,
      obtainedAt: this.obtainedAt,
      ...(resourceMetadataUrl ? { resourceMetadataUrl: resourceMetadataUrl.toString() } : {}),
    };
  }
}

export type ProtectedResourceChallenge = { resourceMetadataUrl?: URL; scope?: string };

/**
 * Ask the MCP server once without credentials, the way an MCP client's first
 * request does, and read its 401: `WWW-Authenticate` may say where the
 * protected-resource metadata lives and which scope to ask for. The SDK only
 * looks at the well-known locations otherwise, and some servers publish the
 * metadata nowhere else — Tencent Docs answers 404 at all of them, so without
 * this the flow falls back to the bare origin and asks for no scope at all.
 * Any answer other than 401 carries no challenge and leaves discovery as is.
 * No answer at all is an error, not «no challenge»: carrying on without it would
 * authorize Tencent Docs with no scope and look connected while every tool fails.
 */
export async function probeProtectedResource(
  serverUrl: string,
  signal: AbortSignal,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  /** 手机的网页没有跨域许可,走原生 HTTP;不给 = 全局 fetch。 */
  fetchFn: FetchLike = fetch
): Promise<ProtectedResourceChallenge> {
  // 手写「调用方取消 ∪ 限时」两路:AbortSignal.any / .timeout 要 WebView 116 / 103,手机上的系统 WebView 不一定这么新。
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener('abort', onAbort, { once: true });
  let response: Response;
  try {
    response = await fetchFn(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'gugu', version: '1.0.0' },
        },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut && !signal.aborted) {
      throw new Error(`${new URL(serverUrl).host} did not answer within ${timeoutMs / 1000}s. Try again.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
  await response.body?.cancel();
  if (response.status !== 401) return {};
  const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
  return {
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    ...(scope ? { scope } : {}),
  };
}

export type BeginMcpAuthorizationOptions = {
  serverUrl: string;
  /** 回跳落在哪(授权服务器注册进去的 redirect_uri);桌面是本机监听的 127.0.0.1,手机是一个不会有人听的回环地址。 */
  redirectUrl: string;
  /** 防串号的随机串:回跳里带回来的 state 要与它相等。 */
  state: string;
  signal: AbortSignal;
  fetchFn?: FetchLike;
};

export type PendingMcpAuthorization = {
  /** 交给浏览器的授权页地址。 */
  authorizationUrl: string;
  /** 授权码到手后换令牌,给出要交给 `connect` 的那份记录。 */
  complete(code: string): Promise<McpOAuthCredentials>;
};

/**
 * 授权的第一段:探一次 401、发现元数据、注册客户端、拼好授权页地址(不开浏览器,不等回跳)。
 * 取消落在这一段里:抛 `McpAuthorizationCancelledError`,❌ 让取消之后的浏览器再被拉起。
 */
export async function beginMcpAuthorization({
  serverUrl,
  redirectUrl,
  state,
  signal,
  fetchFn,
}: BeginMcpAuthorizationOptions): Promise<PendingMcpAuthorization> {
  if (signal.aborted) throw new McpAuthorizationCancelledError();
  let authorizationUrl: URL | undefined;
  const provider = new HostOAuthProvider(redirectUrl, state, async (url) => {
    // Discovery and registration take a moment; a cancel inside that window
    // must not still pop a browser tab.
    if (signal.aborted) throw new McpAuthorizationCancelledError();
    authorizationUrl = url;
  });
  const fetchOption = fetchFn ? { fetchFn } : {};

  const challenge = await probeProtectedResource(serverUrl, signal, PROBE_TIMEOUT_MS, fetchFn).catch(
    (error: unknown) => {
      if (signal.aborted) throw new McpAuthorizationCancelledError();
      throw error;
    }
  );
  const started = await auth(provider, { serverUrl, ...challenge, ...fetchOption });
  if (started !== 'REDIRECT' || !authorizationUrl) {
    throw new Error('The authorization server did not ask for browser authorization.');
  }
  return {
    authorizationUrl: authorizationUrl.toString(),
    complete: async (code) => {
      const finished = await auth(provider, {
        serverUrl,
        ...challenge,
        authorizationCode: code,
        ...fetchOption,
      });
      if (finished !== 'AUTHORIZED') {
        throw new Error('The authorization code could not be exchanged for tokens.');
      }
      return provider.toCredentials(serverUrl, challenge.resourceMetadataUrl);
    },
  };
}
