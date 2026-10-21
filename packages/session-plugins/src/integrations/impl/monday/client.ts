import { err, ok, type Result } from '@gugu/session-shared';
import { parseCredentials } from '../../helpers/credentials';
import type { IntegrationCredentials } from '../../host';
import type { IntegrationError } from '../../types';
import { toMondayIntegrationError } from './error';
import {
  MONDAY_VIEWER_QUERY,
  type MondayClient,
  type MondayCredentials,
  mondayCredentialsSchema,
  type MondayVerifiedConnection,
  type MondayViewerQuery,
} from './types';

export function readMondayCredentials(
  credentials: IntegrationCredentials
): Result<MondayCredentials, IntegrationError> {
  return parseCredentials(mondayCredentialsSchema, credentials);
}

// SDK 按需加载:只有连了这个集成才需要它,❌ 静态 import(那会把整个 SDK 拉进主进程启动路径,见 plain/sdk.ts)。
export async function createMondayClient(credentials: MondayCredentials): Promise<MondayClient> {
  const { ApiClient } = await import('@mondaydotcomorg/api');
  return new ApiClient({ token: credentials.apiToken });
}

export async function verifyMondayCredentials(
  rawCredentials: IntegrationCredentials
): Promise<Result<MondayVerifiedConnection, IntegrationError>> {
  const credentials = readMondayCredentials(rawCredentials);
  if (!credentials.success) return err(credentials.error);

  const client = await createMondayClient(credentials.data);
  try {
    const data = await client.request<MondayViewerQuery>(MONDAY_VIEWER_QUERY);
    const me = data.me;
    return ok({
      displayName: me?.account?.name ?? me?.name,
      displayDetail:
        me?.account?.name && me.name && me.account.name !== me.name ? me.name : undefined,
      credentials: credentials.data,
    });
  } catch (error) {
    return err(toMondayIntegrationError(error, 'Failed to validate Monday.com token.'));
  }
}
