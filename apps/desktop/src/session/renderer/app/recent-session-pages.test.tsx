import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRecentSessions } from './recent-session-pages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let pages: string[] = [];

function Pool({ current, onScreen = [] }: { current: string | null; onScreen?: string[] }) {
  pages = useRecentSessions(
    current ? { projectId: 'p', sessionId: current } : null,
    onScreen.map((sessionId) => ({ projectId: 'p', sessionId }))
  ).map((p) => p.sessionId);
  return null;
}

const visit = (current: string | null, onScreen?: string[]) => act(() => root.render(<Pool current={current} onScreen={onScreen} />));

describe('useRecentSessions: the retained session-page pool', () => {
  beforeEach(() => {
    const dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    root = createRoot(dom.window.document.getElementById('root')!);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('keeps six pages in the order they were first opened; revisiting never moves a page', () => {
    for (const id of ['s1', 's2', 's3', 's4', 's5', 's6']) visit(id);
    visit('s2');
    visit('s5');
    expect(pages).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
  });

  it('the seventh page pushes out the least recently used one, not the first opened', () => {
    for (const id of ['s1', 's2', 's3', 's4', 's5', 's6']) visit(id);
    visit('s1'); // s1 is now the most recent; s2 the least recent
    visit('s7');
    expect(pages).toEqual(['s1', 's3', 's4', 's5', 's6', 's7']);
    visit('s2'); // came back after being pushed out: a new page at the end, s3 leaves
    expect(pages).toEqual(['s1', 's4', 's5', 's6', 's7', 's2']);
  });

  it('a non-session view keeps the pool as it is', () => {
    for (const id of ['s1', 's2']) visit(id);
    visit(null);
    expect(pages).toEqual(['s1', 's2']);
  });

  it('a page in a block of the screen never leaves, however long ago it was looked at (#7052)', () => {
    visit('s1', ['s1']);
    for (const id of ['s2', 's3', 's4', 's5', 's6', 's7', 's8']) visit(id, ['s1', id]);
    expect(pages).toContain('s1');
    expect(pages).toHaveLength(6);
  });

  it('a block holding a session never opened yet mounts its page', () => {
    visit('s1', ['s1', 's9']);
    expect(pages).toEqual(['s1', 's9']);
  });
});
