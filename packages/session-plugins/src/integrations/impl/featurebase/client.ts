import { err, ok, type Result } from '@gugu/session-shared';
import { parseCredentials } from '../../helpers/credentials';
import { toIntegrationError } from '../../helpers/error';
import type { IntegrationCredentials } from '../../host';
import type { IntegrationError } from '../../types';
import {
  type FeaturebaseClient,
  type FeaturebaseCredentials,
  featurebaseCredentialsSchema,
  type FeaturebaseVerifiedConnection,
} from './types';

export const FEATUREBASE_API_URL = 'https://do.featurebase.app';
export const FEATUREBASE_API_VERSION = '2026-01-01.nova';

export function readFeaturebaseCredentials(
  credentials: IntegrationCredentials
): Result<FeaturebaseCredentials, IntegrationError> {
  return parseCredentials(featurebaseCredentialsSchema, credentials);
}

// SDK 按需加载:只有连了这个集成才需要它,❌ 静态 import(那会把整个 SDK 拉进主进程启动路径,见 plain/sdk.ts)。
export async function createFeaturebaseClient(credentials: FeaturebaseCredentials): Promise<FeaturebaseClient> {
  const { default: Featurebase } = await import('featurebase-node');
  return new Featurebase({
    apiKey: credentials.apiKey,
    baseURL: FEATUREBASE_API_URL,
    defaultHeaders: {
      'Featurebase-Version': FEATUREBASE_API_VERSION,
    },
  });
}

export async function verifyFeaturebaseCredentials(
  rawCredentials: IntegrationCredentials
): Promise<Result<FeaturebaseVerifiedConnection, IntegrationError>> {
  const credentials = readFeaturebaseCredentials(rawCredentials);
  if (!credentials.success) return err(credentials.error);

  const client = await createFeaturebaseClient(credentials.data);
  try {
    await client.feedback.posts.list({ limit: 1 });
    return ok({
      credentials: {
        apiKey: credentials.data.apiKey,
      },
    });
  } catch (error) {
    return err(toIntegrationError(error, 'Featurebase'));
  }
}
