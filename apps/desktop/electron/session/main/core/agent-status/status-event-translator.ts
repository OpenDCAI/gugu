import type { AgentEvent } from '@shared/core/agents/agentEvents';
import type { AgentStatusEvent } from './status-event-log';

/**
 * spec status-event-log「翻译」—— hook / ACP / relay 三条腿送来的 `AgentEvent` 翻成带归属的规范事件。
 *
 * 边只说「开工 / 停下 / 等人 / 出错」,❌ 不带轮号:`start` 让会话进入在干活,之后的等待随这次活了结(#7087)。
 * 子代理的边(解析器按 payload 自证)不属于这条会话,不翻。
 */
export interface TranslationContext {
  /** agent 此刻在干活。 */
  running: boolean;
  waiting: boolean;
  /** 处在失败里(上次停下是失败、还没再开工)。 */
  failed: boolean;
  /**
   * spawn 时 argv 上真的推了 auto-approve flag。被自动批准的**批准**不等人;问题 / 计划 / 对话框
   * 没有「自动批准」这回事,照翻。
   */
  autoApproved: boolean;
}

export function translateAgentEvent(event: AgentEvent, ctx: TranslationContext): AgentStatusEvent[] {
  if (event.payload.origin === 'subagent') return [];
  const sessionId = event.sessionId;
  switch (event.type) {
    case 'start':
      // 干活时再来一次开始(qwen 每次调模型前都发、排队的追问被提交)= 接着跑了,停着的等待已了结。
      if (ctx.running) return ctx.waiting ? [{ kind: 'WaitEnded', sessionId, id: '*' }] : [];
      return [{ kind: 'Started', sessionId }];
    case 'stop': {
      const { backgroundTasks, scheduledTasks, outcome } = event.payload;
      if (!ctx.running) {
        // 没在干活:停下本身不是新事实,报来的后台快照仍是事实。
        if (backgroundTasks === undefined && scheduledTasks === undefined) return [];
        return [{ kind: 'TasksObserved', sessionId, backgroundTasks: backgroundTasks ?? 0, scheduledTasks }];
      }
      return [{ kind: 'Stopped', sessionId, backgroundTasks, scheduledTasks, outcome }];
    }
    case 'error':
      return [{ kind: 'Error', sessionId, reason: event.payload.message ?? 'error' }];
    case 'wait': {
      const waitKind = event.payload.waitKind ?? 'approval';
      if (waitKind === 'approval' && ctx.autoApproved) return [];
      return [{ kind: 'WaitStarted', sessionId, id: event.payload.waitId ?? waitKind, waitKind }];
    }
    case 'wait_resolved':
      return ctx.waiting ? [{ kind: 'WaitEnded', sessionId, id: event.payload.waitId ?? '*' }] : [];
    case 'background':
      return [{
        kind: 'TasksObserved',
        sessionId,
        backgroundTasks: event.payload.backgroundTasks ?? 0,
        scheduledTasks: event.payload.scheduledTasks,
      }];
    case 'notification':
      switch (event.payload.notificationType) {
        case 'permission_prompt':
          // 已有开着的等待 = 同一个对话框(PermissionRequest / 问题工具先报了),不再开一个。
          if (ctx.autoApproved || ctx.waiting) return [];
          return [{ kind: 'WaitStarted', sessionId, id: 'permission_prompt', waitKind: 'approval' }];
        case 'idle_prompt':
          // 还在干活 = 它的停下边没来(Esc 打断、取消都不发 stop):这次活是被打断的,不是做完。
          // 已经停下、停在等人或失败上时,闲置提醒不是新事实。
          if (!ctx.running || ctx.waiting || ctx.failed) return [];
          return [{ kind: 'Stopped', sessionId, outcome: 'cancelled' }];
        default:
          return [];
      }
  }
}
