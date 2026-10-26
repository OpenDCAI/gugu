// @vitest-environment jsdom
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { RetainedTabContent, useRetainedTabs } from './retained-tab-content';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement('div');
const root = createRoot(container);
const events: string[] = [];

function Page({ id }: { id: string }) {
  useEffect(() => {
    events.push(`mount ${id}`);
    return () => { events.push(`unmount ${id}`); };
  }, [id]);
  return <textarea data-page={id} defaultValue={id} />;
}

function Tabs({ open, shown }: { open: string[]; shown: string[] }) {
  const retained = useRetainedTabs(open, shown);
  return open.filter((id) => retained.has(id)).map((id) => (
    <RetainedTabContent key={id} visible={shown.includes(id)}><Page id={id} /></RetainedTabContent>
  ));
}

afterEach(() => act(() => root.unmount()));

it('retains drafts in a stable tree, protects both paired tabs, and releases closed or least recently viewed tabs', () => {
  const open = ['a', 'b', 'c', 'd', 'e', 'never'];
  const draw = (shown: string[], ids = open) => act(() => root.render(<Tabs open={ids} shown={shown} />));
  draw(['a']);
  const draft = container.querySelector<HTMLTextAreaElement>('[data-page="a"]')!;
  draft.value = 'unfinished';
  draw(['b']);
  draw(['a', 'b']);
  expect(container.querySelector('[data-page="a"]')).toBe(draft);
  expect(draft.value).toBe('unfinished');
  expect(container.querySelector('[data-page="never"]')).toBeNull();
  draw(['c']);
  draw(['d']);
  draw(['e']);
  expect(events).toEqual(['mount a', 'mount b', 'mount c', 'mount d', 'unmount b', 'mount e']);
  draw(['a', 'e']);
  expect(container.querySelectorAll('textarea')).toHaveLength(4);
  draw(['e'], open.filter((id) => id !== 'a'));
  expect(events.at(-1)).toBe('unmount a');
});
