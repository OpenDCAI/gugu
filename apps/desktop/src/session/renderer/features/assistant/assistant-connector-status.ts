import type { ConnectionStatus } from '@shared/issue-providers';

export type ConnectorState = 'checking' | 'notConnected' | 'connected' | 'needsReauth' | 'checkFailed';

/** 已存凭据与实时检查分开:检查未返回或失败时,不能据此声称连接可用。 */
export function connectorState(configured: boolean | undefined, status: ConnectionStatus | undefined, error?: unknown): ConnectorState {
  if (configured === false) return 'notConnected';
  if (error) return 'checkFailed';
  if (configured === undefined || !status) return 'checking';
  if (status.connected) return 'connected';
  return status.errorType === 'auth_failed' || status.errorType === 'authorization_expired' ? 'needsReauth' : 'checkFailed';
}
