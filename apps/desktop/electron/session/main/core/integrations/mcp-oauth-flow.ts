import { randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpOAuthCredentials } from '@gugu/session-plugins/integrations';
import {
  discoverOAuthServerInfo,
  refreshAuthorization,
  selectResourceURL,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  beginMcpAuthorization,
  HostOAuthProvider,
  McpAuthorizationCancelledError,
} from '@shared/mcp-oauth-client';

// Browser authorization for remote MCP servers — the flow `codex mcp login` and
// Claude Code's `/mcp` run: discovery → dynamic client registration → PKCE →
// token. The SDK speaks the protocol and `@shared/mcp-oauth-client` owns the
// protocol half (the phone shares it); this file owns what that leaves to the
// desktop host: receiving the redirect, and renewing tokens without a browser.
//
// The redirect lands on a one-shot 127.0.0.1 listener. A desktop app has no
// secret to keep and no web origin, which is what loopback redirects for public
// clients exist for (RFC 8252 §7.3).

const CALLBACK_PATH = '/callback';
const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const SUCCESS_PAGE = 'Authorization complete. You can close this tab and return to Gugu.';
const FAILURE_PAGE = 'Authorization did not complete. Return to Gugu for details.';

export { McpAuthorizationCancelledError, probeProtectedResource } from '@shared/mcp-oauth-client';

export class McpReauthorizationRequiredError extends Error {
  constructor() {
    super('Authorization expired or was revoked. Connect again to re-authorize.');
    this.name = 'McpReauthorizationRequiredError';
  }
}

export type AuthorizeMcpServerOptions = {
  serverUrl: string;
  signal: AbortSignal;
  openExternal: (url: string) => Promise<void>;
};

export async function authorizeMcpServer({
  serverUrl,
  signal,
  openExternal,
}: AuthorizeMcpServerOptions): Promise<McpOAuthCredentials> {
  if (signal.aborted) throw new McpAuthorizationCancelledError();
  const state = randomBytes(16).toString('base64url');
  const callback = await listenForCallback(state, signal);
  try {
    const pending = await beginMcpAuthorization({
      serverUrl,
      redirectUrl: callback.redirectUrl,
      state,
      signal,
    });
    // A cancel that landed while discovery ran must not still pop a browser tab.
    if (signal.aborted) throw new McpAuthorizationCancelledError();
    await openExternal(pending.authorizationUrl);
    const code = await callback.waitForCode();
    return await pending.complete(code);
  } finally {
    callback.close();
  }
}

/**
 * Renew the access token with the stored refresh token. Only an OAuth error
 * from the authorization server (invalid_grant, invalid_client, …) means the
 * grant is gone; being offline or a 5xx leaves the stored grant valid and is
 * rethrown as is, so a network blip never tells the user to reconnect.
 */
export async function refreshMcpCredentials(
  credentials: McpOAuthCredentials
): Promise<McpOAuthCredentials> {
  const refreshToken = credentials.tokens.refresh_token;
  if (!refreshToken) throw new McpReauthorizationRequiredError();

  const { authorizationServerUrl, authorizationServerMetadata, resourceMetadata } =
    await discoverOAuthServerInfo(credentials.serverUrl, {
      ...(credentials.resourceMetadataUrl
        ? { resourceMetadataUrl: new URL(credentials.resourceMetadataUrl) }
        : {}),
    });
  const provider = new HostOAuthProvider(credentials.redirectUrl, '', () =>
    Promise.reject(new McpReauthorizationRequiredError())
  );
  const resource = await selectResourceURL(credentials.serverUrl, provider, resourceMetadata);

  try {
    const tokens = await refreshAuthorization(authorizationServerUrl, {
      clientInformation: credentials.clientInformation,
      refreshToken,
      ...(authorizationServerMetadata ? { metadata: authorizationServerMetadata } : {}),
      ...(resource ? { resource } : {}),
    });
    return { ...credentials, tokens, obtainedAt: Date.now() };
  } catch (error) {
    if (error instanceof OAuthError && !(error instanceof ServerError)) {
      throw new McpReauthorizationRequiredError();
    }
    throw error;
  }
}

type CallbackOutcome = { code: string } | { error: Error };

type LoopbackCallback = {
  redirectUrl: string;
  waitForCode: () => Promise<string>;
  close: () => void;
};

function listenForCallback(expectedState: string, signal: AbortSignal): Promise<LoopbackCallback> {
  // The first outcome wins. It is held until the flow asks for it, so a cancel
  // or timeout that lands during discovery is not an unobserved rejection.
  let outcome: CallbackOutcome | undefined;
  let deliver: ((settled: CallbackOutcome) => void) | undefined;
  const settle = (next: CallbackOutcome) => {
    if (outcome) return;
    outcome = next;
    deliver?.(next);
  };
  const waitForCode = () =>
    new Promise<string>((resolve, reject) => {
      deliver = (settled) => ('code' in settled ? resolve(settled.code) : reject(settled.error));
      if (outcome) deliver(outcome);
    });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    if (url.searchParams.get('state') !== expectedState) {
      respond(response, 400, FAILURE_PAGE);
      settle({ error: new Error('The authorization response does not match this request.') });
      return;
    }
    const denied = url.searchParams.get('error');
    if (denied) {
      respond(response, 400, FAILURE_PAGE);
      settle({ error: new Error(url.searchParams.get('error_description') || denied) });
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      respond(response, 400, FAILURE_PAGE);
      settle({ error: new Error('The authorization response carried no code.') });
      return;
    }
    respond(response, 200, SUCCESS_PAGE);
    settle({ code });
  });

  const timer = setTimeout(
    () => settle({ error: new Error('Authorization timed out. Try again.') }),
    AUTHORIZATION_TIMEOUT_MS
  );
  timer.unref();
  const onAbort = () => settle({ error: new McpAuthorizationCancelledError() });
  signal.addEventListener('abort', onAbort, { once: true });
  const close = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    server.close();
    server.closeAllConnections();
  };

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      close();
      reject(error);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ redirectUrl: `http://127.0.0.1:${port}${CALLBACK_PATH}`, waitForCode, close });
    });
  });
}

function respond(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Gugu</title><p style="font:15px system-ui;margin:48px">${message}</p>`
  );
}
