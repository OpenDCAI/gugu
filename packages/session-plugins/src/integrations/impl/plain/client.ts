import { err, ok, type Result } from '@gugu/session-shared';
import { parseCredentials } from '../../helpers/credentials';
import type { IntegrationCredentials } from '../../host';
import type { IntegrationError } from '../../types';
import { toPlainIntegrationError } from './error';
import { loadPlainSdk } from './sdk';
import {
  type PlainClient,
  type PlainCredentials,
  plainCredentialsSchema,
  type PlainVerifiedConnection,
} from './types';

export function readPlainCredentials(
  credentials: IntegrationCredentials
): Result<PlainCredentials, IntegrationError> {
  return parseCredentials(plainCredentialsSchema, credentials);
}

export async function createPlainClient(credentials: PlainCredentials): Promise<PlainClient> {
  const { PlainClient: PlainSdkClient } = await loadPlainSdk();
  return new PlainSdkClient({ apiKey: credentials.apiKey });
}

export async function verifyPlainCredentials(
  rawCredentials: IntegrationCredentials
): Promise<Result<PlainVerifiedConnection, IntegrationError>> {
  const credentials = readPlainCredentials(rawCredentials);
  if (!credentials.success) return err(credentials.error);

  const client = await createPlainClient(credentials.data);
  try {
    await client.query.threads({ first: 1 });
    return ok({
      credentials: credentials.data,
    });
  } catch (error) {
    return err(await toPlainIntegrationError(error, 'Failed to validate Plain API key.'));
  }
}
