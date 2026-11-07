import type { PermissionCaller } from './operation'
import { decidePermission, type PermissionDecision, type PermissionOperation, type PermissionPolicy } from './rules'

export interface PasswordPermissionCaller extends PermissionCaller {
  installationId: string
  deviceId: string
}

/** Resolved by the owning host, never by the request, a chat sender or an App annotation. */
export interface PasswordResourceAuthority {
  ownerId: string
  agentOwnerId: string
  agentId: string
  sessionId: string
  installationId: string
  deviceId: string
  toolScope: string
}

const actorKeys = ['ownerId', 'subjectId', 'sessionId', 'installationId', 'deviceId', 'toolScope'] as const

/**
 * Common policy only: even a successful check requires the ONE existing per-use person approval.
 * This function issues no capability and runs no effect. The integrated host must freshly resolve
 * the caller/resource and policy before every protected stage, independently of generic MCP mode.
 * Credential IDs, website/form data and request/use IDs never become generic rule selectors here.
 */
export function decidePasswordUsePermission(input: {
  caller: Readonly<PasswordPermissionCaller> | null
  resource: Readonly<PasswordResourceAuthority> | null
  policy: PermissionPolicy | null
}): PermissionDecision {
  const { caller, resource, policy } = input
  const identified = caller !== null && actorKeys.every(key => typeof caller[key] === 'string' && caller[key].trim().length > 0)
  const boundaryAllowed = identified && resource !== null && resource.ownerId === caller.ownerId
    && resource.agentOwnerId === caller.ownerId && resource.agentId === caller.subjectId
    && resource.sessionId === caller.sessionId && resource.installationId === caller.installationId
    && resource.deviceId === caller.deviceId && resource.toolScope === caller.toolScope
  const operation: PermissionOperation = {
    tool: 'password.use', namespace: 'password', effect: 'credential', risk: 'high', classified: true,
    resource: identified ? { device: caller.deviceId, installation: caller.installationId, scope: caller.toolScope } : {},
  }
  return decidePermission({ operation, agentId: caller?.subjectId ?? '', policy, boundaryAllowed })
}
