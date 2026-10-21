import { err, ok, type Result } from '@gugu/session-shared';
import { parseCredentials } from '../../helpers/credentials';
import { toIntegrationError } from '../../helpers/error';
import type { IntegrationCredentials } from '../../host';
import type { IntegrationError } from '../../types';
import {
  type PlaneClient,
  type PlaneCredentials,
  planeCredentialsSchema,
  type PlaneVerifiedConnection,
} from './types';

export function readPlaneCredentials(
  credentials: IntegrationCredentials
): Result<PlaneCredentials, IntegrationError> {
  return parseCredentials(planeCredentialsSchema, credentials);
}

// SDK 按需加载:只有连了这个集成才需要它,❌ 静态 import(那会把整个 SDK 拉进主进程启动路径,见 plain/sdk.ts)。
export async function createPlaneClient(credentials: PlaneCredentials): Promise<PlaneClient> {
  const { PlaneClient: PlaneSdkClient } = await import('@makeplane/plane-node-sdk');
  return new PlaneSdkClient({
    baseUrl: credentials.apiBaseUrl,
    apiKey: credentials.apiKey,
  });
}

export async function verifyPlaneCredentials(
  rawCredentials: IntegrationCredentials
): Promise<Result<PlaneVerifiedConnection, IntegrationError>> {
  const credentials = readPlaneCredentials(rawCredentials);
  if (!credentials.success) return err(credentials.error);

  const client = await createPlaneClient(credentials.data);
  const { workspaceSlug, apiBaseUrl } = credentials.data;
  try {
    const user = await client.users.me();
    await client.projects.list(workspaceSlug, { limit: 1 });

    const fullName = [user.first_name?.trim(), user.last_name?.trim()].filter(Boolean).join(' ');
    return ok({
      displayName: user.display_name?.trim() || fullName || user.email?.trim() || undefined,
      displayDetail: `${workspaceSlug} on ${new URL(apiBaseUrl).host}`,
      credentials: credentials.data,
    });
  } catch (error) {
    return err(toIntegrationError(error, 'Plane'));
  }
}
