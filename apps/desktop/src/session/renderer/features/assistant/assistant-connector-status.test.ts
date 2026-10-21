import { describe, expect, it } from 'vitest';
import type { ConnectionStatus } from '@shared/issue-providers';
import { connectorState } from './assistant-connector-status';

const status = (connected: boolean, errorType?: ConnectionStatus['errorType']): ConnectionStatus => ({ connected, errorType, capabilities: { requiresRepositoryUrl: false, supportsIssueContext: false } });

describe('connectorState', () => {
  it('does not report saved credentials as a verified connection', () => {
    expect(connectorState(undefined, undefined)).toBe('checking');
    expect(connectorState(true, undefined)).toBe('checking');
    expect(connectorState(false, undefined)).toBe('notConnected');
    expect(connectorState(true, status(true))).toBe('connected');
  });
  it('distinguishes expired authorization from a service or network failure', () => {
    expect(connectorState(true, status(false, 'authorization_expired'))).toBe('needsReauth');
    expect(connectorState(true, status(false, 'auth_failed'))).toBe('needsReauth');
    expect(connectorState(true, status(false, 'rate_limited'))).toBe('checkFailed');
    expect(connectorState(true, status(false, 'host_unreachable'))).toBe('checkFailed');
    expect(connectorState(true, status(true), new Error('refresh failed'))).toBe('checkFailed');
    expect(connectorState(undefined, undefined, new Error('credentials unreadable'))).toBe('checkFailed');
  });
});
