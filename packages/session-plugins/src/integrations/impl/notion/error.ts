import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { IntegrationError } from '../../types';

export function toNotionIntegrationError(
  error: unknown,
  fallback = 'Notion request failed.'
): IntegrationError {
  if (error instanceof StreamableHTTPError && typeof error.code === 'number') {
    if (error.code === 401 || error.code === 403) {
      return {
        type: 'auth_failed',
        message: 'Notion authorization expired or was revoked. Reconnect Notion.',
      };
    }
    if (error.code === 429) {
      return {
        type: 'rate_limited',
        message: 'Notion rate limit exceeded. Please try again shortly.',
      };
    }
    if (error.code >= 500) {
      return {
        type: 'host_unreachable',
        message: 'Notion is temporarily unavailable. Please try again.',
      };
    }
  }
  if (error instanceof Error && error.message) return { type: 'generic', message: error.message };
  return { type: 'generic', message: fallback };
}
