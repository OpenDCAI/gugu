/** @jsxImportSource solid-js */
import { textFilePatch } from '@gugu/session-core/lib';

/**
 * #4981 —— `diff` / `file-op` 两个行族的失败原因(与 subagent 同一个死路径)。
 *
 * owner 问「举一反三,相关的其他错误你有找到吗」——找到了,而且是同一个:
 * 这两族也把失败原因读成 `item.error`,而**产品路径从没给这一格赋过值**;
 * 整个包里唯二的赋值点在 `diff.stories.tsx` 与 `file-operation.stories.tsx`。
 * ⇒ Storybook 里看着好好的,真机上永远只有「失败」两个字。
 *
 * ⚠️ 这正是 Storybook 骗过我的机制:story 手工塞了产品从不填的字段。
 * 所以这些判据判的是 **presenter**,❌ 不判 story。
 *
 * 放在 browser project 而不是隔壁那个 node 测里,是因为 `diff.def` / `file-op.def`
 * 在模块求值时就要 `document`(vanilla-extract + Solid),node 环境下直接 collect 失败。
 */
import type { SegmentCtx } from '@session-chat/core/units';
import { defaultChatTranslator } from '@session-chat/localization';
import { describe, expect, it } from 'vitest';
import type { ToolNode } from '@session-chat/model';
import { patchDiffFromItem } from './diff/diff.def';
import { readFileOpFromItem } from './file-op/file-op.def';

function ctx(): SegmentCtx {
  return {
    caches: {} as SegmentCtx['caches'],
    expanded: () => false,
    active: false,
    plan: () => null,
    translate: defaultChatTranslator,
    pendingToolCallIds: () => new Set<string>(),
    terminalOutputText: () => null,
    terminalExitStatus: () => null,
  };
}

type CreateFileToolCall = Extract<ToolNode, { kind: 'patch-tool-call' }>;
type ModifyFileToolCall = Extract<ToolNode, { kind: 'patch-tool-call' }>;
type ReadToolCall = Extract<ToolNode, { kind: 'read-tool-call' }>;
type DeleteFileToolCall = Extract<ToolNode, { kind: 'patch-tool-call' }>;

const FAILED = "EACCES: permission denied, open '/etc/hosts'";

describe('#4981 写文件失败要说得出原因', () => {
  it('create-file 失败时把 outputText 当原因交出来', () => {
    const item: CreateFileToolCall = {
      kind: 'patch-tool-call',
      id: 'd1',
      seq: 0,
      toolCallId: 'c1',
      title: 'Write',
      contentBlocks: [textFilePatch('src/a.ts', null, 'x')],

      status: 'error',
      outputText: FAILED,
    };
    expect(patchDiffFromItem(item, ctx()).error).toBe(FAILED);
  });

  it('modify-file 失败时退而求其次读 rawOutput', () => {
    const item: ModifyFileToolCall = {
      kind: 'patch-tool-call',
      id: 'd2',
      seq: 0,
      toolCallId: 'c2',
      title: 'Edit',
      contentBlocks: [textFilePatch('src/b.ts', 'a', 'b')],

      status: 'error',
      rawOutput: '{"code":"ENOENT"}',
    };
    expect(patchDiffFromItem(item, ctx()).error).toBe('{"code":"ENOENT"}');
  });

  it('没失败就不把输出当错误 —— 成功的写入不该顶着一行红字', () => {
    // 阴控:只改 status 这一个自由度。
    const item: CreateFileToolCall = {
      kind: 'patch-tool-call',
      id: 'd3',
      seq: 0,
      toolCallId: 'c3',
      title: 'Write',
      contentBlocks: [textFilePatch('src/c.ts', null, 'x')],

      status: 'done',
      outputText: '写入成功',
    };
    expect(patchDiffFromItem(item, ctx()).error).toBeUndefined();
  });
});

describe('#4981 读/删文件失败要说得出原因', () => {
  it('read 失败时把 outputText 当原因交出来', () => {
    const item: ReadToolCall = {
      kind: 'read-tool-call',
      id: 'f1',
      seq: 0,
      toolCallId: 'c4',
      title: 'Read',
      path: 'src/missing.ts',
      status: 'error',
      outputText: FAILED,
    };
    expect(readFileOpFromItem(item, ctx()).error).toBe(FAILED);
  });

  it('delete 失败时同样交得出原因', () => {
    const item: DeleteFileToolCall = {
      kind: 'patch-tool-call',
      id: 'f2',
      seq: 0,
      toolCallId: 'c5',
      title: 'Delete',
      contentBlocks: [textFilePatch('src/gone.ts', '', null)],
      status: 'error',
      outputText: FAILED,
    };
    expect(patchDiffFromItem(item, ctx()).error).toBe(FAILED);
  });

  it('成功的读取不带错误', () => {
    const item: ReadToolCall = {
      kind: 'read-tool-call',
      id: 'f3',
      seq: 0,
      toolCallId: 'c6',
      title: 'Read',
      path: 'src/ok.ts',
      status: 'done',
      outputText: 'file contents',
    };
    expect(readFileOpFromItem(item, ctx()).error).toBeUndefined();
  });
});
