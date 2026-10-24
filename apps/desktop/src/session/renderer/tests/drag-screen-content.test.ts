import { afterEach, describe, expect, it } from 'vitest';
import { terminalSessionMentionInput } from '@renderer/lib/chat/use-session-mention-drop';
import {
  clearDraggedScreenContent,
  getDraggedScreenContent,
  hasDraggedScreenContent,
  SCREEN_CONTENT_DRAG_TYPE,
  setDraggedScreenContent,
  type DraggedScreenContent,
} from '@renderer/lib/drag-screen-content';

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

afterEach(clearDraggedScreenContent);

describe('drag-screen-content', () => {
  it.each<DraggedScreenContent>([
    { kind: 'session', projectId: 'p', sessionId: 's', title: 'Task' },
    { kind: 'chat', chatId: 'c', title: 'Chat' },
    { kind: 'app', tabKind: 'app-test', title: 'App' },
    { kind: 'project', projectId: 'p', title: 'Project' },
  ])('carries $kind through the same-window and serialized paths', (content) => {
    const dataTransfer = makeDataTransfer();
    setDraggedScreenContent(dataTransfer, content);
    expect(hasDraggedScreenContent(dataTransfer)).toBe(true);
    expect(getDraggedScreenContent(dataTransfer)).toEqual(content);
    expect(dataTransfer.types).toEqual([SCREEN_CONTENT_DRAG_TYPE]);
    expect(dataTransfer.effectAllowed).toBe(content.kind === 'session' ? 'copyMove' : 'move');
    clearDraggedScreenContent();
    expect(getDraggedScreenContent(dataTransfer)).toEqual(content);
  });

  it.each([
    '{', 'null', '"chat"',
    JSON.stringify({ sessionId: 'old', title: 'Old payload' }),
    JSON.stringify({ kind: 'session', sessionId: 's', title: 'Missing project' }),
    JSON.stringify({ kind: 'chat', title: 'Missing chat id' }),
    JSON.stringify({ kind: 'app', title: 'Missing tab kind' }),
    JSON.stringify({ kind: 'project', title: 'Missing project id' }),
    JSON.stringify({ kind: 'unknown', title: 'Unknown' }),
  ])('ignores malformed content %s', (payload) => {
    const dataTransfer = makeDataTransfer();
    dataTransfer.setData(SCREEN_CONTENT_DRAG_TYPE, payload);
    expect(getDraggedScreenContent(dataTransfer)).toBeNull();
  });

  it('ignores a transfer that is not tagged as a session drag', () => {
    const dataTransfer = makeDataTransfer();
    dataTransfer.setData('text/plain', 'just text');
    setDraggedScreenContent(makeDataTransfer(), { kind: 'session', projectId: 'p', sessionId: 'conv-3', title: 'stale' });

    // 标记不在这次 dataTransfer 上,上一次拖拽留在模块变量里的残留就不该被收走。
    expect(hasDraggedScreenContent(dataTransfer)).toBe(false);
    expect(getDraggedScreenContent(dataTransfer)).toBeNull();
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
