import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authorizeMcpServer,
  McpAuthorizationCancelledError,
  McpReauthorizationRequiredError,
  probeProtectedResource,
  refreshMcpCredentials,
} from './mcp-oauth-flow';

// A real OAuth authorization server on 127.0.0.1 (protected-resource metadata,
// AS metadata, dynamic registration, token endpoint) driven by the real SDK —
// the same exchange Notion's hosted MCP performs, without the network.

type RecordedRequest = { path: string; body: string };

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

type AuthorizationServerOptions = {
  refresh?: 'ok' | 'invalid_grant';
  /**
   * Tencent Docs' shape: the protected-resource metadata is served only at the
   * address the MCP endpoint's 401 names; every well-known location is 404.
   */
  metadataOnlyInChallenge?: { scopes: string[] };
  /**
   * Feishu's shape: the authorization server's issuer has a path, and its
   * metadata lives only at the RFC 8414 path-inserted well-known address.
   */
  issuerPath?: string;
};

async function startAuthorizationServer(options: AuthorizationServerOptions = {}) {
  const requests: RecordedRequest[] = [];
  let issued = 0;
  let base = '';

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', base);
      const body = await readBody(request);
      requests.push({ path: url.pathname, body });
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };

      const issuer = `${base}${options.issuerPath ?? ''}`;
      const challengeMetadataPath = '/mcp/.well-known/oauth-protected-resource';
      if (url.pathname === '/mcp' && request.method === 'POST') {
        response.writeHead(401, {
          'WWW-Authenticate': options.metadataOnlyInChallenge
            ? `Bearer resource_metadata="${base}${challengeMetadataPath}"`
            : 'Bearer',
        });
        response.end();
      } else if (options.metadataOnlyInChallenge && url.pathname === challengeMetadataPath) {
        json(200, {
          resource: `${base}/mcp`,
          authorization_servers: [issuer],
          scopes_supported: options.metadataOnlyInChallenge.scopes,
        });
      } else if (
        !options.metadataOnlyInChallenge &&
        url.pathname.startsWith('/.well-known/oauth-protected-resource')
      ) {
        json(200, { resource: base, authorization_servers: [issuer] });
      } else if (url.pathname === `/.well-known/oauth-authorization-server${options.issuerPath ?? ''}`) {
        json(200, {
          issuer,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      } else if (url.pathname === '/register') {
        json(201, { ...(JSON.parse(body) as Record<string, unknown>), client_id: 'client-1' });
      } else if (url.pathname === '/token') {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') === 'refresh_token' && options.refresh === 'invalid_grant') {
          json(400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
          return;
        }
        issued += 1;
        json(200, {
          access_token: `access-${issued}`,
          token_type: 'bearer',
          refresh_token: `refresh-${issued}`,
          expires_in: 3600,
        });
      } else {
        response.writeHead(404).end();
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);
  return { serverUrl: `${base}/mcp`, requests };
}

/** Plays the browser: approves on the authorization page and follows the redirect. */
function fakeBrowser(tamper: (redirect: URL) => void = () => {}) {
  const opened: URL[] = [];
  const visits: Array<Promise<number>> = [];
  const openExternal = async (target: string) => {
    const authorization = new URL(target);
    opened.push(authorization);
    const redirect = new URL(authorization.searchParams.get('redirect_uri') ?? '');
    redirect.searchParams.set('code', 'code-1');
    redirect.searchParams.set('state', authorization.searchParams.get('state') ?? '');
    tamper(redirect);
    visits.push(fetch(redirect).then((response) => response.status));
  };
  return { openExternal, opened, visits };
}

function tokenRequests(requests: RecordedRequest[]) {
  return requests.filter((request) => request.path === '/token');
}

describe('authorizeMcpServer', () => {
  it('registers a public client, sends the user to the browser and exchanges the code', async () => {
    const authServer = await startAuthorizationServer();
    const browser = fakeBrowser();

    const credentials = await authorizeMcpServer({
      serverUrl: authServer.serverUrl,
      signal: new AbortController().signal,
      openExternal: browser.openExternal,
    });

    expect(await Promise.all(browser.visits)).toEqual([200]);
    expect(credentials.serverUrl).toBe(authServer.serverUrl);
    expect(credentials.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(credentials.clientInformation.client_id).toBe('client-1');
    expect(credentials.tokens).toMatchObject({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
    });
    expect(credentials.obtainedAt).toBeGreaterThan(0);

    const registration = authServer.requests.find((request) => request.path === '/register');
    expect(JSON.parse(registration?.body ?? '{}')).toMatchObject({
      redirect_uris: [credentials.redirectUrl],
      token_endpoint_auth_method: 'none',
    });
    expect(browser.opened[0]?.searchParams.get('code_challenge_method')).toBe('S256');

    const [exchange] = tokenRequests(authServer.requests);
    const form = new URLSearchParams(exchange?.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('code-1');
    expect(form.get('code_verifier')).toBeTruthy();
  });

  it('rejects a redirect whose state does not match and never exchanges its code', async () => {
    const authServer = await startAuthorizationServer();
    const browser = fakeBrowser((redirect) => redirect.searchParams.set('state', 'forged'));

    await expect(
      authorizeMcpServer({
        serverUrl: authServer.serverUrl,
        signal: new AbortController().signal,
        openExternal: browser.openExternal,
      })
    ).rejects.toThrow('does not match');
    expect(await Promise.all(browser.visits)).toEqual([400]);
    expect(tokenRequests(authServer.requests)).toEqual([]);
  });

  it('surfaces a denial with the server description', async () => {
    const authServer = await startAuthorizationServer();
    const browser = fakeBrowser((redirect) => {
      redirect.searchParams.delete('code');
      redirect.searchParams.set('error', 'access_denied');
      redirect.searchParams.set('error_description', 'The user denied access');
    });

    await expect(
      authorizeMcpServer({
        serverUrl: authServer.serverUrl,
        signal: new AbortController().signal,
        openExternal: browser.openExternal,
      })
    ).rejects.toThrow('The user denied access');
    expect(tokenRequests(authServer.requests)).toEqual([]);
  });

  it('finds metadata the server names only in its 401 and asks for the scopes it lists', async () => {
    const authServer = await startAuthorizationServer({
      metadataOnlyInChallenge: { scopes: ['docs:read', 'docs:write'] },
    });
    const browser = fakeBrowser();

    const credentials = await authorizeMcpServer({
      serverUrl: authServer.serverUrl,
      signal: new AbortController().signal,
      openExternal: browser.openExternal,
    });

    const authorization = browser.opened[0];
    expect(authorization?.searchParams.get('scope')).toBe('docs:read docs:write');
    expect(authorization?.searchParams.get('resource')).toBe(authServer.serverUrl);
    expect(credentials.resourceMetadataUrl).toBe(
      authServer.serverUrl.replace(/\/mcp$/, '/mcp/.well-known/oauth-protected-resource')
    );
    const [exchange] = tokenRequests(authServer.requests);
    expect(new URLSearchParams(exchange?.body).get('resource')).toBe(authServer.serverUrl);
  });

  it('finds authorization server metadata inserted before the issuer path (RFC 8414)', async () => {
    const authServer = await startAuthorizationServer({ issuerPath: '/tenant' });
    const browser = fakeBrowser();

    const credentials = await authorizeMcpServer({
      serverUrl: authServer.serverUrl,
      signal: new AbortController().signal,
      openExternal: browser.openExternal,
    });

    expect(credentials.tokens.access_token).toBe('access-1');
    expect(authServer.requests.map((request) => request.path)).toContain(
      '/.well-known/oauth-authorization-server/tenant'
    );
    expect(credentials.resourceMetadataUrl).toBeUndefined();
  });

  it('stops waiting when cancelled after the browser opened', async () => {
    const authServer = await startAuthorizationServer();
    const controller = new AbortController();

    await expect(
      authorizeMcpServer({
        serverUrl: authServer.serverUrl,
        signal: controller.signal,
        openExternal: async () => controller.abort(),
      })
    ).rejects.toBeInstanceOf(McpAuthorizationCancelledError);
    expect(tokenRequests(authServer.requests)).toEqual([]);
  });
});

describe('probeProtectedResource', () => {
  it('says the server did not answer instead of hanging the authorization', async () => {
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    servers.push(silent);
    const url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/mcp`;

    await expect(probeProtectedResource(url, new AbortController().signal, 50)).rejects.toThrow(
      'did not answer within 0.05s'
    );
  });
});

describe('refreshMcpCredentials', () => {
  function stored(serverUrl: string, refreshToken?: string) {
    return {
      serverUrl,
      redirectUrl: 'http://127.0.0.1:53682/callback',
      clientInformation: { client_id: 'client-1' },
      tokens: {
        access_token: 'access-old',
        token_type: 'bearer',
        expires_in: 3600,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
      },
      obtainedAt: 0,
    };
  }

  it('renews the access token with the refresh token and the registered client', async () => {
    const authServer = await startAuthorizationServer();
    const credentials = stored(authServer.serverUrl, 'refresh-old');

    const refreshed = await refreshMcpCredentials(credentials);

    expect(refreshed.tokens).toMatchObject({ access_token: 'access-1', refresh_token: 'refresh-1' });
    expect(refreshed.clientInformation).toEqual(credentials.clientInformation);
    expect(refreshed.obtainedAt).toBeGreaterThan(0);
    const [request] = tokenRequests(authServer.requests);
    const form = new URLSearchParams(request?.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('refresh-old');
    expect(form.get('client_id')).toBe('client-1');
  });

  it('renews against the metadata address the authorization found in the 401', async () => {
    const authServer = await startAuthorizationServer({
      metadataOnlyInChallenge: { scopes: ['docs:read'] },
    });
    const credentials = {
      ...stored(authServer.serverUrl, 'refresh-old'),
      resourceMetadataUrl: authServer.serverUrl.replace(
        /\/mcp$/,
        '/mcp/.well-known/oauth-protected-resource'
      ),
    };

    const refreshed = await refreshMcpCredentials(credentials);

    expect(refreshed.tokens.access_token).toBe('access-1');
    expect(refreshed.resourceMetadataUrl).toBe(credentials.resourceMetadataUrl);
    const [request] = tokenRequests(authServer.requests);
    expect(new URLSearchParams(request?.body).get('resource')).toBe(authServer.serverUrl);
  });

  it('asks for re-authorization when the server rejects the refresh token', async () => {
    const authServer = await startAuthorizationServer({ refresh: 'invalid_grant' });

    await expect(
      refreshMcpCredentials(stored(authServer.serverUrl, 'refresh-old'))
    ).rejects.toBeInstanceOf(McpReauthorizationRequiredError);
  });

  it('asks for re-authorization when no refresh token was issued', async () => {
    await expect(
      refreshMcpCredentials(stored('http://127.0.0.1:9/mcp'))
    ).rejects.toBeInstanceOf(McpReauthorizationRequiredError);
  });

  it('does not blame the grant when the server is unreachable', async () => {
    const authServer = await startAuthorizationServer();
    const server = servers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    const refresh = refreshMcpCredentials(stored(authServer.serverUrl, 'refresh-old'));
    await expect(refresh).rejects.toThrow();
    await expect(refresh).rejects.not.toBeInstanceOf(McpReauthorizationRequiredError);
  });
});
