import { decodeSessionUpdate } from '@gugu/session-core/acp';
/**
 * #7139 别家的计划审批：工具名在 `_meta` 里，基线解码就提上来（不靠某一家的 transport decoder），认「等的是计划」的
 * 那一处读同一份名单。形状取自读源码：qwen-code 0.22.3（准备帧 `_meta.toolName`）、qoder 1.1.71（`_meta.qoder.toolName`）。
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { permissionWaitKind } from '../models/permissions';
import type { AcpPermissionRequest, ToolCallItem } from '../models';
import { AcpTranscriptParser } from './parser';

function itemFrom(update: Record<string, unknown>): ToolCallItem {
  const parser = new AcpTranscriptParser({ sessionId: 's' });
  parser.pushEvent(decodeSessionUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'plan it' } } as never), 1);
  parser.pushEvent(decodeSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'call-plan', status: 'pending', ...update } as SessionUpdate), 2);
  const item = parser.activeTurn?.items.find((one) => 'toolCallId' in one && one.toolCallId === 'call-plan');
  if (!item) throw new Error('no tool item');
  return item as ToolCallItem;
}

const request = (toolCall: ToolCallItem): AcpPermissionRequest => ({
  requestId: 'r1',
  toolCall,
  options: [
    { optionId: 'proceed_once', name: 'Yes, and manually approve edits', kind: 'allow_once' },
    { optionId: 'cancel', name: 'No, keep planning (esc)', kind: 'reject_once' },
  ],
});

describe('the vendor tool name rides from `_meta` without a per-vendor hook', () => {
  it('qwen: `_meta.toolName` on the preparing frame', () => {
    const item = itemFrom({ title: 'ExitPlanMode', kind: 'switch_mode', rawInput: {}, _meta: { toolName: 'exit_plan_mode', phase: 'preparing' } });
    expect(item).toMatchObject({ title: 'ExitPlanMode', toolName: 'exit_plan_mode' });
    expect(permissionWaitKind(request(item))).toBe('plan');
  });

  it('qoder: `_meta.<vendor>.toolName` under its own key, the title is a sentence', () => {
    const item = itemFrom({ title: 'Ready to start implementation?', kind: 'other', _meta: { qoder: { toolName: 'ExitPlanMode' } } });
    expect(item).toMatchObject({ title: 'Ready to start implementation?', toolName: 'ExitPlanMode' });
    expect(permissionWaitKind(request(item))).toBe('plan');
  });

  it('two nested keys naming different tools ⇒ no name (❌ whichever key comes first); the same name twice is fine', () => {
    const torn = itemFrom({ title: 'Run', kind: 'execute', _meta: { proxy: { toolName: 'Bash' }, claudeCode: { toolName: 'ExitPlanMode' } } });
    expect(torn.toolName).toBeUndefined();
    const agreed = itemFrom({ title: 'Run', kind: 'execute', _meta: { proxy: { toolName: 'Bash' }, claudeCode: { toolName: 'Bash' } } });
    expect(agreed.toolName).toBe('Bash');
  });

  it('counter-cell: no name in `_meta` ⇒ only the title, and the same request reads as an approval', () => {
    const item = itemFrom({ title: 'Ready to start implementation?', kind: 'other', _meta: { qoder: { phase: 'x' } } });
    expect(item.toolName).toBeUndefined();
    expect(permissionWaitKind(request(item))).toBe('approval');
  });
});
