/**
 * 10-12(手机提问卡车道):Claude 的 ACP 适配器把计划批准报成 `title: "Approve Plan"`、`kind: "switch_mode"`,
 * 工具名 ExitPlanMode 只在 `_meta.claudeCode.toolName`。不提上来,认「这是哪个工具」的两处都认不出来:
 * 桌面折叠把这次问用户的调用收进「Took Ns」(手机读会话记录、标题就是工具名,所以手机切开、桌面不切),
 * 权限请求被判成「批准」—— 完全访问档只替人点批准,于是计划也被替人点掉。
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { AcpTranscriptParser, permissionWaitKind, type AcpPermissionRequest, type NormalizedEvent, type ToolCallItem } from '@gugu/session-core/acp';
import { describe, expect, it } from 'vitest';
import { enrichClaudeUpdate } from './acp-transform';

const planCall = (meta: Record<string, unknown> | undefined): SessionUpdate =>
  ({
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_plan',
    title: 'Approve Plan',
    kind: 'switch_mode',
    status: 'pending',
    rawInput: { plan: '# Plan: create notes.txt' },
    ...(meta ? { _meta: meta } : {}),
  }) as never;

function itemFrom(update: SessionUpdate): ToolCallItem {
  const parser = new AcpTranscriptParser({ sessionId: 's', enrich: enrichClaudeUpdate });
  parser.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'plan it' } } as never, 1);
  parser.push(update, 2);
  const item = parser.activeTurn?.items.find((one) => 'toolCallId' in one && one.toolCallId === 'toolu_plan');
  if (!item) throw new Error('no tool item');
  return item as ToolCallItem;
}

// 适配器真实的计划批准选项(@gugu-acp/claude-agent-acp 1.4.0):三个放行 + 一个「继续规划」。
const request = (toolCall: ToolCallItem): AcpPermissionRequest => ({
  requestId: 'r1',
  toolCall,
  options: [
    { optionId: 'acceptEdits', name: 'Yes, and auto-accept edits', kind: 'allow_always' },
    { optionId: 'default', name: 'Yes, manually approve edits', kind: 'allow_once' },
    { optionId: 'plan', name: 'No, keep planning', kind: 'reject_once' },
  ],
});

describe('Claude ACP: the tool name rides from `_meta` onto the transcript item', () => {
  it('the plan approval keeps its display title and carries ExitPlanMode; its permission request reads as a plan', () => {
    const item = itemFrom(planCall({ claudeCode: { toolName: 'ExitPlanMode' } }));
    expect(item).toMatchObject({ title: 'Approve Plan', toolName: 'ExitPlanMode' });
    expect(permissionWaitKind(request(item))).toBe('plan');
  });

  it('counter-cell: without the `_meta` name it is only a title, and the same request reads as an approval', () => {
    const item = itemFrom(planCall(undefined));
    expect(item.toolName).toBeUndefined();
    expect(permissionWaitKind(request(item))).toBe('approval');
  });

  it('enrich adds only the name: an update that carries nothing else stays the same object without it', () => {
    const event: NormalizedEvent = { kind: 'tool_call', toolCallId: 't', title: 'Read', toolKind: 'read', status: null, parentToolCallId: null, diffs: [], locations: [] };
    const raw = { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Read' } as never;
    expect(enrichClaudeUpdate(event, raw)).toBe(event);
    expect(enrichClaudeUpdate(event, { ...(raw as object), _meta: { claudeCode: { toolName: 'Read' } } } as never)).toEqual({ ...event, toolName: 'Read' });
  });
});
