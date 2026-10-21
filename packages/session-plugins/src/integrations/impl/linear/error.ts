import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { IntegrationError } from '../../types';

/**
 * Linear 现在只经它的托管 MCP 走,所以错误来自 HTTP / MCP,不再来自 @linear/sdk 的 GraphQL 错误类。
 */
export function toLinearIntegrationError(
  error: unknown,
  fallback = 'Linear request failed.'
): IntegrationError {
  if (error instanceof StreamableHTTPError && typeof error.code === 'number') {
    if (error.code === 401 || error.code === 403) {
      return {
        type: 'auth_failed',
        message: 'Linear authorization expired or was revoked. Reconnect Linear.',
      };
    }
    if (error.code === 429) {
      return {
        type: 'rate_limited',
        message: 'Linear rate limit exceeded. Please try again shortly.',
      };
    }
    if (error.code >= 500) {
      return {
        type: 'host_unreachable',
        message: 'Linear is temporarily unavailable. Please try again.',
      };
    }
  }
  if (error instanceof Error && error.message) return { type: 'generic', message: error.message };
  return { type: 'generic', message: fallback };
}
