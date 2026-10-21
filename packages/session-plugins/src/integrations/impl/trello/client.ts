import { err, ok, type Result } from '@gugu/session-shared';
import { parseCredentials } from '../../helpers/credentials';
import { toIntegrationError } from '../../helpers/error';
import type { IntegrationCredentials } from '../../host';
import type { IntegrationError } from '../../types';
import {
  type TrelloClient,
  type TrelloCredentials,
  trelloCredentialsSchema,
  type TrelloVerifiedConnection,
} from './types';

export function readTrelloCredentials(
  credentials: IntegrationCredentials
): Result<TrelloCredentials, IntegrationError> {
  return parseCredentials(trelloCredentialsSchema, credentials);
}

// SDK 按需加载:只有连了这个集成才需要它,❌ 静态 import(那会把整个 SDK 拉进主进程启动路径,见 plain/sdk.ts)。
export async function createTrelloClient(credentials: TrelloCredentials): Promise<TrelloClient> {
  const { createTrelloClient: createClient } = await import('trello.js');
  return createClient({
    apiKey: credentials.apiKey,
    apiToken: credentials.apiToken,
    skipParsing: true,
  });
}

export async function verifyTrelloCredentials(
  rawCredentials: IntegrationCredentials
): Promise<Result<TrelloVerifiedConnection, IntegrationError>> {
  const credentials = readTrelloCredentials(rawCredentials);
  if (!credentials.success) return err(credentials.error);
  const client = await createTrelloClient(credentials.data);
  try {
    const me = await client.members.getMember({
      id: 'me',
      fields: ['fullName', 'username'],
    });
    return ok({
      displayName: me.fullName ?? me.username,
      displayDetail:
        me.fullName && me.username && me.fullName !== me.username ? `@${me.username}` : undefined,
      credentials: {
        apiKey: credentials.data.apiKey,
        apiToken: credentials.data.apiToken,
      },
    });
  } catch (error) {
    return err(toIntegrationError(error, 'Trello'));
  }
}
