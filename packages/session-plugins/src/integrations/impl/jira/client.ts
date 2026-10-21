import { err, ok, type Result } from '@gugu/session-shared';
import { parseCredentials } from '../../helpers/credentials';
import { toIntegrationError } from '../../helpers/error';
import type { IntegrationCredentials } from '../../host';
import type { IntegrationError } from '../../types';
import {
  type JiraClient,
  type JiraCredentials,
  jiraCredentialsSchema,
  type JiraVerifiedConnection,
} from './types';

export function readJiraCredentials(
  credentials: IntegrationCredentials
): Result<JiraCredentials, IntegrationError> {
  return parseCredentials(jiraCredentialsSchema, credentials);
}

// SDK 按需加载:只有连了这个集成才需要它,❌ 静态 import(那会把整个 SDK 拉进主进程启动路径,见 plain/sdk.ts)。
export async function createJiraClient(credentials: JiraCredentials): Promise<JiraClient> {
  const { Version3Client } = await import('jira.js');
  return new Version3Client({
    host: credentials.siteUrl,
    authentication: {
      basic: {
        email: credentials.email,
        apiToken: credentials.apiToken,
      },
    },
  });
}

export async function verifyJiraCredentials(
  rawCredentials: IntegrationCredentials
): Promise<Result<JiraVerifiedConnection, IntegrationError>> {
  const credentials = readJiraCredentials(rawCredentials);
  if (!credentials.success) return err(credentials.error);

  const client = await createJiraClient(credentials.data);
  try {
    const user = await client.myself.getCurrentUser();
    return ok({
      displayName: user.displayName,
      displayDetail: `${credentials.data.email} · ${new URL(credentials.data.siteUrl).host}`,
      credentials: credentials.data,
    });
  } catch (error) {
    return err(toIntegrationError(error, 'Jira'));
  }
}
