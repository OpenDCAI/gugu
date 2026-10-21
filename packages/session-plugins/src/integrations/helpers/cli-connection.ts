import z from 'zod';
import type { VerifyResult } from '../capabilities/auth';
import type { IntegrationCredentials } from '../host';

/**
 * What gugu keeps for a `cli` integration: only that this machine connected it, and through
 * which tool. The login itself stays inside the vendor's tool (its own keychain / config), so
 * there is no token here to leak or to renew — the tool renews its own.
 */
export const cliConnectionRecordSchema = z.object({
  tool: z.enum(['dws', 'wecom-cli', 'lark-cli', 'tmeet']),
  /** Epoch ms of the login that created this record. */
  connectedAt: z.number(),
});

export type CliConnectionRecord = z.infer<typeof cliConnectionRecordSchema>;

/**
 * A `cli` plugin's `verify`: the record is well-formed and names this plugin's tool. Whether the
 * tool is still logged in is asked of the tool itself by the host (it owns the process and the
 * tool's directory), not decided here from a stored token.
 */
export function verifyCliConnectionRecord(
  name: string,
  tool: CliConnectionRecord['tool'],
  credentials: IntegrationCredentials
): VerifyResult {
  const parsed = cliConnectionRecordSchema.safeParse(credentials);
  if (!parsed.success || parsed.data.tool !== tool) {
    return {
      connected: false,
      error: { type: 'auth_failed', message: `${name} is not connected through ${tool}. Connect it again.` },
    };
  }
  return { connected: true };
}
