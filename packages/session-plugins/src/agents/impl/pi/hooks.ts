import { HOOK_WAIT_KINDS, type CanonicalHookEvent, type HookWaitKind } from '@gugu/session-core/agents/plugins';
import { defaultHookEventParser } from '@gugu/session-core/agents/plugins/helpers';

/**
 * pi 的回传是咕咕自己的事件模块(`plugin-file.ts`)POST 的 body,字段由那份模块定义;读不懂就响亮失败。
 * `stop {outcome?}`、`wait {waitKind, waitId}` / `wait_resolved {waitId}`、`error {message}`。
 */
function readOutcome(body: Record<string, unknown>): { outcome?: 'cancelled' } {
  if (body.outcome === undefined) return {};
  if (body.outcome !== 'cancelled') throw new Error(`pi stop event carries unknown outcome ${String(body.outcome)}`);
  return { outcome: 'cancelled' };
}

function readWaitId(body: Record<string, unknown>, eventType: string): string {
  const waitId = body.waitId;
  if (typeof waitId !== 'string' || !waitId) throw new Error(`pi ${eventType} event carries no waitId`);
  return waitId;
}

function readWaitKind(body: Record<string, unknown>): HookWaitKind {
  const kind = body.waitKind;
  if (!HOOK_WAIT_KINDS.includes(kind as HookWaitKind)) throw new Error(`pi wait event carries unknown waitKind ${String(kind)}`);
  return kind as HookWaitKind;
}

export function parsePiHookEvent(eventType: string, body: Record<string, unknown>): CanonicalHookEvent {
  switch (eventType) {
    case 'stop': {
      const event = defaultHookEventParser(eventType, body);
      return event.kind === 'status' ? { ...event, ...readOutcome(body) } : event;
    }
    case 'wait':
      return {
        kind: 'status',
        type: 'wait',
        waitKind: readWaitKind(body),
        waitId: readWaitId(body, eventType),
        title: typeof body.title === 'string' ? body.title : undefined,
      };
    case 'wait_resolved':
      return { kind: 'status', type: 'wait_resolved', waitId: readWaitId(body, eventType) };
    default:
      return defaultHookEventParser(eventType, body);
  }
}
