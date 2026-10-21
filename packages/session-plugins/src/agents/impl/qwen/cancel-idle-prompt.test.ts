import { makeStdinHookCommand } from '@gugu/session-core/agents/plugins/helpers';
import { describe, expect, it } from 'vitest';
import { provider as qwen } from '.';
import { qwenHookSpecs } from './hooks';

// qwen 取消回合时不发 Stop,只发 Notification{idle_prompt}(#6421)。这条边装上、并解析成 idle_prompt,
// 取消的回合才有终点;PermissionRequest(旧安装经 notification 发来)仍然先于它按等人翻(#6448)。
describe('qwen cancel edge (#6421)', () => {
  it('installs the Notification hook as a notification event', () => {
    expect(qwenHookSpecs()).toContainEqual({ hookKey: 'Notification', command: makeStdinHookCommand('notification') });
  });

  it('parses the payload qwen sends on Esc as idle_prompt', () => {
    // 字段取自 mac1 上 qwen 0.24.4 取消时真实发出的 hook stdin。
    const parsed = qwen.behavior.hooks!.parseHookEvent!('notification', {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
    });
    expect(parsed).toMatchObject({ kind: 'status', type: 'notification', notificationType: 'idle_prompt' });
  });

  it('still reads a PermissionRequest that arrives as a notification as a wait, not as idle_prompt', () => {
    const parsed = qwen.behavior.hooks!.parseHookEvent!('notification', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'run_shell_command',
    });
    expect(parsed).toMatchObject({ kind: 'status', type: 'wait', waitKind: 'approval' });
  });
});
