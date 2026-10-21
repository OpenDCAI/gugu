import { permissionWaitKind, type AcpPermissionRequest } from '@gugu/session-core/acp';
import { describe, expect, it } from 'vitest';
import { pendingPermissionWaits } from './permission-broker';

/**
 * #6448 一条权限请求在等人什么 —— 自动作答(只替人点批准)与状态投影(needs_user 的附属态)共用这一份判据。
 * 名单认工具名,其余只认 ACP 标准 option kind 的结构;每一格都有与它只差一处的对照。
 */
function request(
  title: string,
  kinds: readonly string[],
  requestId = 'r1',
): AcpPermissionRequest {
  return {
    requestId,
    toolCall: { kind: 'generic-tool-call', id: 'tool-1', toolCallId: 'tool-1', title, status: 'pending' },
    options: kinds.map((kind, index) => ({ optionId: `o${index}`, name: `option ${index}`, kind })),
  } as unknown as AcpPermissionRequest;
}

describe('permissionWaitKind (#6448)', () => {
  it('names plan approval and the question tool by their tool names', () => {
    expect(permissionWaitKind(request('ExitPlanMode', ['allow_always', 'allow_once', 'reject_once']))).toBe('plan');
    expect(permissionWaitKind(request('AskUserQuestion', ['allow_once', 'reject_once']))).toBe('question');
  });

  // 10-12:Claude ACP 适配器的标题是显示名(「Approve Plan」),工具名在 toolName(EnrichHook 从 `_meta` 提上来);
  // 会话记录里标题就是工具名。两种形状各一格,认名字只经 toolCallName 一处。
  it('reads the tool name when the title is a display label (Claude ACP shape), else the title (record shape)', () => {
    const acp = (title: string, toolName: string, kinds: readonly string[]) => {
      const r = request(title, kinds);
      return { ...r, toolCall: { ...r.toolCall, toolName } } as AcpPermissionRequest;
    };
    expect(permissionWaitKind(acp('Approve Plan', 'ExitPlanMode', ['allow_always', 'allow_once', 'reject_once']))).toBe('plan');
    expect(permissionWaitKind(acp('Ask the user', 'AskUserQuestion', ['allow_once', 'reject_once']))).toBe('question');
    expect(permissionWaitKind(request('ExitPlanMode', ['allow_always', 'allow_once', 'reject_once']))).toBe('plan');
    // 对照:同一个显示标题、没有工具名 ⇒ 只能按选项结构判
    expect(permissionWaitKind(request('Approve Plan', ['allow_always', 'allow_once', 'reject_once']))).toBe('approval');
  });

  it('reads an allow-or-refuse request as an approval', () => {
    expect(permissionWaitKind(request('Run a command', ['allow_always', 'allow_once', 'reject_once']))).toBe('approval');
    expect(permissionWaitKind(request('Edit a file', ['allow_always', 'reject_always']))).toBe('approval');
  });

  it('reads a bare single "proceed" as an approval', () => {
    expect(permissionWaitKind(request('Run a command', ['allow_once']))).toBe('approval');
  });

  it('reads a choose-one request with no way to refuse as a question (pi select, codex requestUserInput)', () => {
    // pi-acp: pi 的 `select` → 每个选项都是 allow_once 的 `choice-N`。
    expect(permissionWaitKind(request('Pick a target', ['allow_once', 'allow_once', 'allow_once']))).toBe('question');
    // codex 桥:requestUserInput 的选项 kind 全是 `other`。
    expect(permissionWaitKind(request('Which approach?', ['other', 'other']))).toBe('question');
    expect(permissionWaitKind(request('Which approach?', ['other']))).toBe('question');
  });

  it('does not read the title text', () => {
    expect(permissionWaitKind(request('Ask the user which file?', ['allow_once', 'reject_once']))).toBe('approval');
  });

  it('projects the pending list in order with each request’s kind', () => {
    expect(pendingPermissionWaits([
      request('Run a command', ['allow_once', 'reject_once'], 'a'),
      request('ExitPlanMode', ['allow_once', 'reject_once'], 'b'),
      request('Pick a target', ['allow_once', 'allow_once'], 'c'),
    ])).toEqual([
      { requestId: 'a', waitKind: 'approval' },
      { requestId: 'b', waitKind: 'plan' },
      { requestId: 'c', waitKind: 'question' },
    ]);
  });
});
