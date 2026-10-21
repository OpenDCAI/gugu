import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import {
  permissionWaitKind,
  type AcpPermissionOption,
  type AcpPermissionRequest,
  type PendingPermissionWait,
} from '@gugu/session-core/acp';

type PermissionResolver = (response: RequestPermissionResponse) => void;

/** 摘要上那份「待决请求各自在等什么」:与 `pendingPermissions` 同序、一一对应。 */
export function pendingPermissionWaits(
  pending: readonly AcpPermissionRequest[],
): PendingPermissionWait[] {
  return pending.map((request) => ({
    requestId: request.requestId,
    waitKind: permissionWaitKind(request),
  }));
}

export class AcpPermissionResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpPermissionResolutionError';
  }
}

/**
 * 完全访问档替用户作答时选哪一项 —— 只按 ACP 标准 `kind`,❌ 不看是哪一家。
 *
 * `allow_once` 优先:档位是**这条会话**的事实,而 `allow_always` 在有的家会写成跨会话的持久规则
 * (把本会话的授权带出会话、降档后也收不回)。只报 `allow_always` 的家才落到它。
 * 一个 allow 都没有 ⇒ 抛错(fail loud),❌ 不退回「挂着等人点」。
 */
export function selectAutoApproveOption(request: AcpPermissionRequest): AcpPermissionOption {
  const option =
    request.options.find((candidate) => candidate.kind === 'allow_once')
    ?? request.options.find((candidate) => candidate.kind === 'allow_always');
  if (!option) {
    throw new AcpPermissionResolutionError(
      `Full-access session got a permission request with no standard allow option `
        + `(kinds: ${request.options.map((candidate) => candidate.kind).join(', ') || 'none'})`
    );
  }
  return option;
}

export class PermissionBroker {
  private readonly resolvers = new Map<string, PermissionResolver>();

  request(request: AcpPermissionRequest): Promise<RequestPermissionResponse> {
    return new Promise<RequestPermissionResponse>((resolve) => {
      this.resolvers.set(request.requestId, resolve);
    });
  }

  settle(requestId: string, optionId: string): boolean {
    const resolver = this.resolvers.get(requestId);
    if (!resolver) return false;
    this.resolvers.delete(requestId);
    resolver({ outcome: { outcome: 'selected', optionId } });
    return true;
  }

  cancel(requestId: string): boolean {
    const resolver = this.resolvers.get(requestId);
    if (!resolver) return false;
    this.resolvers.delete(requestId);
    resolver({ outcome: { outcome: 'cancelled' } });
    return true;
  }

  drain(requests: readonly AcpPermissionRequest[]): void {
    for (const request of requests) {
      this.cancel(request.requestId);
    }
  }
}
