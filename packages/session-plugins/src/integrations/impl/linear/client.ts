import { err, ok, type Result } from '@gugu/session-shared';
import { readMcpOAuthCredentials, type McpOAuthCredentials } from '../../helpers/mcp-oauth';
import { listMcpToolNames, withMcpClient } from '../../helpers/mcp-tool-client';
import type { IntegrationCredentials } from '../../host';
import type { IntegrationError } from '../../types';
import { toLinearIntegrationError } from './error';
import { LINEAR_RECONNECT_MESSAGE } from './types';

/** 工单选择器要用的两个读工具;缺哪个都服务不了它。 */
const REQUIRED_TOOLS = ['list_issues', 'get_issue'] as const;

export function readLinearCredentials(
  credentials: IntegrationCredentials
): Result<McpOAuthCredentials, IntegrationError> {
  return readMcpOAuthCredentials(credentials, LINEAR_RECONNECT_MESSAGE);
}

export async function verifyLinearCredentials(
  rawCredentials: IntegrationCredentials
): Promise<Result<void, IntegrationError>> {
  const credentials = readLinearCredentials(rawCredentials);
  if (!credentials.success) return err(credentials.error);

  try {
    const tools = await withMcpClient(credentials.data, listMcpToolNames);
    const missing = REQUIRED_TOOLS.filter((tool) => !tools.includes(tool));
    if (missing.length > 0) {
      // 把服务器**实际**给的工具名一起报出来:对方改名时这条消息本身就是诊断,
      // ❌ 别只说「不支持」让人去猜。
      return err({
        type: 'generic',
        message: `Linear MCP does not expose ${missing.join(', ')}. It offers: ${tools.join(', ')}.`,
      });
    }
    return ok(undefined);
  } catch (error) {
    return err(toLinearIntegrationError(error, 'Failed to verify Linear authorization.'));
  }
}
