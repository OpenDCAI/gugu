import { describe, expect, it } from 'vitest';
import { terminalSessionMentionInput } from '@renderer/lib/chat/use-session-mention-drop';
import {
  clearDraggedSession,
  getDraggedSession,
  hasDraggedSession,
  SESSION_DRAG_TYPE,
  setDraggedSession,
} from '@renderer/lib/drag-session';

function makeDataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  const transfer = {
    types: [] as string[],
    files: [] as unknown as FileList,
    effectAllowed: 'all',
    setData(type: string, value: string) {
      if (!values.has(type)) this.types.push(type);
      values.set(type, value);
    },
    getData(type: string) {
      return values.get(type) ?? '';
    },
  };
  return transfer as unknown as DataTransfer;
}

describe('drag-session', () => {
  it('carries the dragged session for same-window drops', () => {
    const dataTransfer = makeDataTransfer();

    setDraggedSession(dataTransfer, { sessionId: 'conv-1', title: '头像抽卡' });

    expect(hasDraggedSession(dataTransfer)).toBe(true);
    expect(getDraggedSession(dataTransfer)).toEqual({
      sessionId: 'conv-1',
      title: '头像抽卡',
    });
    clearDraggedSession();
  });

  it('never writes text/plain — ProseMirror would insert it beside the pill', () => {
    const dataTransfer = makeDataTransfer();

    setDraggedSession(dataTransfer, { sessionId: 'conv-1', title: '头像抽卡' });

    expect(dataTransfer.types).toEqual([SESSION_DRAG_TYPE]);
    clearDraggedSession();
  });

  it('falls back to the serialized payload when the module store was cleared', () => {
    const source = makeDataTransfer();
    setDraggedSession(source, { sessionId: 'conv-2', title: '列表见 hapi' });
    clearDraggedSession();

    expect(getDraggedSession(source)).toEqual({
      sessionId: 'conv-2',
      title: '列表见 hapi',
    });
  });

  it('ignores a transfer that is not tagged as a session drag', () => {
    const dataTransfer = makeDataTransfer();
    dataTransfer.setData('text/plain', 'just text');
    setDraggedSession(makeDataTransfer(), { sessionId: 'conv-3', title: 'stale' });

    // 标记不在这次 dataTransfer 上,上一次拖拽留在模块变量里的残留就不该被收走。
    expect(hasDraggedSession(dataTransfer)).toBe(false);
    expect(getDraggedSession(dataTransfer)).toBeNull();
    clearDraggedSession();
  });
});

describe('拖到终端上写进去的那段字', () => {
  const ADDRESS = 'aid:d24d4986-40c5-479a-90be-cbc66cbd35e8';

  it('与聊天框同一种写法:名字在前、Agent ID 在括号里,末尾留一个空格方便接着打字', () => {
    expect(terminalSessionMentionInput({ name: 'Codex 1', label: ADDRESS })).toBe(
      `@[Codex 1](${ADDRESS}) `
    );
  });

  it('名册里没有它(还没身份)就什么都不写 —— ❌ 不退而写一个发不出去的名字', () => {
    expect(terminalSessionMentionInput(null)).toBeNull();
    expect(terminalSessionMentionInput({ name: '', label: ADDRESS })).toBeNull();
    expect(terminalSessionMentionInput({ name: '   ', label: ADDRESS })).toBeNull();
    expect(terminalSessionMentionInput({ name: 'Codex 1', label: '' })).toBeNull();
  });
});
