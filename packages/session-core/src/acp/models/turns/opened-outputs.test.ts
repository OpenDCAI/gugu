import { describe, expect, it } from 'vitest';
import { openedFilePath, openedOutputKey, openedOutputOf } from './opened-outputs';
import type { TranscriptItem } from './turn';

/** 一次 open_in_tab 调用,形状取自真实记录(Claude:`mcp__gugu__session_open_in_tab`,回答是工具返回的那段 JSON)。 */
function openCall(over: {
  server?: string;
  tool?: string;
  status?: 'running' | 'done' | 'error';
  input?: unknown;
  answer?: unknown;
  rawOutput?: string;
}): TranscriptItem {
  return {
    kind: 'mcp-tool-call',
    id: 't1:tool:c1',
    seq: 0,
    toolCallId: 'c1',
    title: 'mcp__gugu__session_open_in_tab',
    server: over.server ?? 'gugu',
    tool: over.tool ?? 'session_open_in_tab',
    status: over.status ?? 'done',
    rawInput: JSON.stringify(over.input ?? {}),
    ...(over.answer !== undefined ? { outputText: JSON.stringify(over.answer) } : {}),
    ...(over.rawOutput !== undefined ? { rawOutput: over.rawOutput } : {}),
  } as TranscriptItem;
}

describe('openedOutputOf', () => {
  it('reads a file from the answer (absolute path), not the relative input', () => {
    const item = openCall({
      input: { path: 'report/index.html' },
      answer: { opened: true, path: '/work/report/index.html', intent: 'pinned' },
    });
    expect(openedOutputOf(item)).toEqual({ kind: 'file', path: '/work/report/index.html' });
  });

  it('reads a page from the answer (the normalized url)', () => {
    const item = openCall({ input: { url: '127.0.0.1:4187/zh/' }, answer: { opened: true, url: 'http://127.0.0.1:4187/zh/', intent: 'pinned' } });
    expect(openedOutputOf(item)).toEqual({ kind: 'page', url: 'http://127.0.0.1:4187/zh/' });
  });

  it('counts a queued open (the session was not on screen) — the file is still what the agent handed over', () => {
    const item = openCall({ input: { path: '/r.html' }, answer: { opened: false, queued: true, path: '/r.html', intent: 'pinned' } });
    expect(openedOutputOf(item)).toEqual({ kind: 'file', path: '/r.html' });
  });

  it('falls back to the input when the answer is not readable', () => {
    expect(openedOutputOf(openCall({ input: { path: '/a.md' }, rawOutput: 'not json' }))).toEqual({ kind: 'file', path: '/a.md' });
    expect(openedOutputOf(openCall({ input: { path: 'C:\\r\\a.md' }, rawOutput: 'not json' }))).toEqual({ kind: 'file', path: 'C:\\r\\a.md' });
  });

  it('does not take a relative input path at face value (it is relative to a session folder this side does not know)', () => {
    expect(openedOutputOf(openCall({ input: { path: 'report/index.html' }, rawOutput: 'not json' }))).toBeNull();
  });

  it('accepts the Claude Code plugin form of the gugu server', () => {
    const item = openCall({ server: 'plugin_gugu-product_gugu', input: { path: '/a.html' }, answer: { opened: true, path: '/a.html' } });
    expect(openedOutputOf(item)).toEqual({ kind: 'file', path: '/a.html' });
  });

  it.each([
    ['another server with the same tool name', { server: 'other', input: { path: '/a.html' } }],
    ['another gugu tool', { tool: 'message_send_file', input: { path: '/a.html' } }],
    ['a failed open', { status: 'error' as const, input: { path: '/missing.html' } }],
    ['a call still running', { status: 'running' as const, input: { path: '/a.html' } }],
    ['an App tab with no file', { input: { app_tab: 'paper-desk:main' }, answer: { opened: true, app_tab: 'paper-desk:main' } }],
    ['a group file', { input: { url: 'gugu-file://00000000-0000-4000-8000-000000000001' }, answer: { opened: true, url: 'gugu-file://00000000-0000-4000-8000-000000000001' } }],
  ])('does not count %s', (_label, over) => {
    expect(openedOutputOf(openCall(over))).toBeNull();
  });

  it('is not fooled by other kinds of rows', () => {
    expect(openedOutputOf({ kind: 'message', id: 'm', seq: 0, role: 'assistant', text: 'hi' } as TranscriptItem)).toBeNull();
  });
});

describe('openedFilePath / openedOutputKey', () => {
  it('treats a file:// page as the same file as a path open', () => {
    const viaUrl = { kind: 'page' as const, url: 'file:///Users/a/%E6%8A%A5%E5%91%8A.html' };
    const viaPath = { kind: 'file' as const, path: '/Users/a/报告.html' };
    expect(openedFilePath(viaUrl)).toBe('/Users/a/报告.html');
    expect(openedOutputKey(viaUrl)).toBe(openedOutputKey(viaPath));
  });

  it('keeps a Windows drive path', () => {
    expect(openedFilePath({ kind: 'page', url: 'file:///C:/r/a.html' })).toBe('C:/r/a.html');
  });

  it('has no file path for a web page', () => {
    expect(openedFilePath({ kind: 'page', url: 'https://example.com/a' })).toBeNull();
    expect(openedOutputKey({ kind: 'page', url: 'https://example.com/a' })).toBe('page:https://example.com/a');
  });
});
