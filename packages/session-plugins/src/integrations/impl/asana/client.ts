import { err, ok, type Result } from '@gugu/session-shared';
import { parseCredentials } from '../../helpers/credentials';
import { toIntegrationError } from '../../helpers/error';
import type { IntegrationCredentials } from '../../host';
import type { IntegrationError } from '../../types';
import {
  type AsanaClient,
  type AsanaCredentials,
  asanaCredentialsSchema,
  type AsanaResponse,
  type AsanaUser,
  type AsanaVerifiedConnection,
} from './types';

export const USER_OPT_FIELDS = 'gid,name,workspaces.gid,workspaces.name';

export function readAsanaCredentials(
  credentials: IntegrationCredentials
): Result<AsanaCredentials, IntegrationError> {
  return parseCredentials(asanaCredentialsSchema, credentials);
}

// SDK 按需加载:只有连了这个集成才需要它,❌ 静态 import(那会把整个 SDK 拉进主进程启动路径,见 plain/sdk.ts)。
export async function createAsanaClient(credentials: AsanaCredentials): Promise<AsanaClient> {
  const { ApiClient, TasksApi, UsersApi } = await import('asana');
  const client = new ApiClient();
  client.RETURN_COLLECTION = false;
  client.authentications.token.accessToken = credentials.accessToken;

  const users = new UsersApi(client);
  const tasks = new TasksApi(client);
  return {
    users,
    tasks,
  };
}

export async function verifyAsanaCredentials(
  rawCredentials: IntegrationCredentials
): Promise<Result<AsanaVerifiedConnection, IntegrationError>> {
  const credentials = readAsanaCredentials(rawCredentials);
  if (!credentials.success) return err(credentials.error);

  const client = await createAsanaClient(credentials.data);
  try {
    const response = (await client.users.getUser('me', {
      opt_fields: USER_OPT_FIELDS,
    })) as AsanaResponse<AsanaUser>;
    const user = response.data;
    if (!user)
      return err({
        type: 'generic',
        message: 'Unexpected Asana user response',
      });
    const workspace = user.workspaces?.[0];
    const displayName = workspace?.name ?? user.name;
    const displayDetail =
      workspace?.name && user.name && workspace.name !== user.name ? user.name : undefined;
    return ok({
      displayName,
      displayDetail,
      credentials: {
        accessToken: credentials.data.accessToken,
      },
    });
  } catch (error) {
    return err(toIntegrationError(error, 'Asana'));
  }
}
