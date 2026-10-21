import { err, ok, type Result } from '@gugu/session-shared';
import z from 'zod';
import type { IntegrationCredentials } from '../host';
import type { IntegrationError } from '../types';

/**
 * Record the host persists for an `mcp-oauth` connection. The dynamically
 * registered client travels with the tokens: a refresh must present the
 * client_id that obtained them. The redirect URI is kept because the SDK only
 * takes the authorization-code/refresh path when a redirect URI exists.
 */
export const mcpOAuthCredentialsSchema = z.object({
  serverUrl: z.string().min(1),
  redirectUrl: z.string().min(1),
  clientInformation: z.looseObject({
    client_id: z.string().min(1),
    client_secret: z.string().optional(),
  }),
  tokens: z.looseObject({
    access_token: z.string().min(1),
    token_type: z.string(),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
    scope: z.string().optional(),
  }),
  /** Epoch ms at which `tokens` were issued; `expires_in` counts from here. */
  obtainedAt: z.number(),
  /**
   * Where the server said its protected-resource metadata lives (the 401's
   * `WWW-Authenticate: resource_metadata=`). Some servers publish it only
   * there — Tencent Docs answers 404 at every well-known location — so a
   * refresh must look it up the same way the authorization did.
   */
  resourceMetadataUrl: z.string().optional(),
});

export type McpOAuthCredentials = z.infer<typeof mcpOAuthCredentialsSchema>;

export function readMcpOAuthCredentials(
  raw: IntegrationCredentials,
  reconnectMessage: string
): Result<McpOAuthCredentials, IntegrationError> {
  const parsed = mcpOAuthCredentialsSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  // A record that does not parse predates browser authorization (or is corrupt).
  // Neither is repairable without the user, so tell them what to do instead of
  // reporting a schema path.
  return err({ type: 'auth_failed', message: reconnectMessage });
}

/** The stored form: exactly what survives JSON persistence. */
export function toIntegrationCredentials(credentials: McpOAuthCredentials): IntegrationCredentials {
  return JSON.parse(JSON.stringify(credentials)) as IntegrationCredentials;
}

/** Renew a minute early so a request does not race the expiry. */
const EXPIRY_MARGIN_MS = 60_000;

export function accessTokenExpiresSoon(
  credentials: McpOAuthCredentials,
  now: number = Date.now()
): boolean {
  const expiresIn = credentials.tokens.expires_in;
  // No advertised lifetime means nothing to schedule; a rejected token then
  // surfaces as auth_failed on the call itself.
  if (expiresIn === undefined) return false;
  return credentials.obtainedAt + expiresIn * 1000 - EXPIRY_MARGIN_MS <= now;
}
