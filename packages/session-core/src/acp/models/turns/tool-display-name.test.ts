import { describe, expect, it } from 'vitest';
import { permissionToPendingRequest } from '../../../session-record/live-requests';
import { recentActionName } from '../../recent-actions';
import { toolCallLabel, toolDisplayName, type McpToolCall, type ToolCallItem } from './tool-calls';

// 咕咕的 catalog_call 替 agent 跑目录里的另一个工具(输入 `{ tool, args }`):会话页、最近动作、待批卡片、手机看会话
// 写的都该是被跑的那个工具,❌ 一律写成 catalog_call。
function mcpCall(tool: string, rawInput?: string): McpToolCall {
  return {
    kind: 'mcp-tool-call',
    id: 'm1',
    seq: 1,
    toolCallId: 'm1',
    title: `mcp__plugin_gugu-product_gugu__${tool}`,
    status: 'done',
    server: 'plugin_gugu-product_gugu',
    tool,
    ...(rawInput !== undefined ? { rawInput } : {}),
  };
}

const catalogRoll = JSON.stringify({ tool: 'dice__roll', args: { sides: 6 } }, null, 2);

describe('toolDisplayName · MCP', () => {
  it('catalog_call 是它输入里点名的那个工具(App 的工具是 <app id>__<tool>)', () => {
    expect(toolDisplayName(mcpCall('catalog_call', catalogRoll))).toBe('dice__roll');
  });

  it('输入还没到(Claude 的第一条 tool_call 是 `{}`)或说不清,就照旧', () => {
    expect(toolDisplayName(mcpCall('catalog_call'))).toBe('catalog_call');
    expect(toolDisplayName(mcpCall('catalog_call', '{}'))).toBe('catalog_call');
    expect(toolDisplayName(mcpCall('catalog_call', 'not json'))).toBe('catalog_call');
    expect(toolDisplayName(mcpCall('catalog_call', JSON.stringify({ tool: 3 })))).toBe('catalog_call');
  });

  it('别的工具不看输入', () => {
    expect(toolDisplayName(mcpCall('message_send', JSON.stringify({ tool: 'dice__roll' })))).toBe('message_send');
  });
});

describe('经 catalog_call 跑的工具,各处写它自己的名字', () => {
  it('最近动作', () => {
    expect(recentActionName(mcpCall('catalog_call', catalogRoll))).toBe('dice__roll');
  });

  it('待批卡片:标题是 server · 工具,副标题是这次调用的入参(批之前看得到要做什么)', () => {
    const pending = permissionToPendingRequest({
      requestId: 'p1',
      toolCall: mcpCall('catalog_call', catalogRoll),
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    });
    expect(pending.title).toBe('plugin_gugu-product_gugu · dice__roll');
    expect(pending.detail).toBe(catalogRoll);
    const noInput = permissionToPendingRequest({ requestId: 'p3', toolCall: mcpCall('message_send'), options: [] });
    expect(noInput.detail).toBeUndefined();
  });

  it('待批卡片:没有名字时只写 server,不留一个孤零零的「 · 」', () => {
    const pending = permissionToPendingRequest({
      requestId: 'p2',
      toolCall: mcpCall('unknown'),
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    });
    expect(pending.title).toBe('plugin_gugu-product_gugu');
  });
});

describe('toolCallLabel · 审批时怎么称呼这次调用', () => {
  it('用户自己的 MCP:server · 工具;没有 server 只写工具', () => {
    expect(toolCallLabel({ ...mcpCall('browser_navigate'), server: 'playwright', title: 'mcp__playwright__browser_navigate' })).toBe('playwright · browser_navigate');
    const serverless = mcpCall('browser_navigate');
    delete serverless.server;
    expect(toolCallLabel(serverless)).toBe('browser_navigate');
  });

  it('别的调用写它的名字', () => {
    const read = { kind: 'read-tool-call', id: 'r1', seq: 1, toolCallId: 'r1', title: 'Read src/main.ts', status: 'done', path: 'src/main.ts' } as ToolCallItem;
    expect(toolCallLabel(read)).toBe('Read src/main.ts');
  });
});
