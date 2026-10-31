import { afterAll, beforeAll, expect, it } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import * as language from '@codemirror/language';
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import * as lezerHighlight from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import html from '../../../../../preinstalled-apps/workspace/index.html?raw';
import workspaceCss from '../../../../../preinstalled-apps/workspace/style.css?raw';
import tokensCss from '@/styles/tokens.css?raw';
import uiCss from '@/session/app-runtime/ui/ui.css?raw';
import { appPaletteCss } from '@/session/app-runtime/ui/app-palette.mjs';
import { renderer } from '@/session/app-runtime/markdown-entry';
import '@/session/app-runtime/markdown.css';
import { until } from '../../../../../../../tests/support/awaitCondition';

// The shipped App, its actual Markdown renderer/CodeMirror and its shipped styles. Only the host's file/context API
// is supplied here; pointer input goes through Chromium, not dispatchEvent or direct show/hide calls.
const entry = { id: 'reachability', chat: 'group', name: 'reachability.md', type: 'text', contentType: 'text/markdown', sourceMessageIds: [] };
const file = {
  entry, type: 'text', readOnly: false, status: 'online',
  text: '# Reading\n\nFirst paragraph keeps its own actions.\n\nSecond paragraph has different source lines.\n\n' + 'More reading below.\n\n'.repeat(40),
  onChange: () => () => {}, onStatus: () => () => {}, close: () => {},
  presence: { self: { userId: 'reader', color: '' }, others: [], onChange: () => () => {}, set: () => {} },
};
const copied: string[] = [];
const verbs = {
  openLink: async () => {}, openBrowserTab: async () => {}, reportError: async (message: string) => { throw new Error(message); },
  clipboard: { writeText: async (text: string) => { copied.push(text); } },
  files: { open: async () => file, readVersion: async () => file, onChanged: () => () => {} },
};
const gugu = {
  ...verbs,
  getContext: async () => ({ locale: 'en', themeMode: 'light', chat: { id: 'group', name: 'Test group', kind: 'group', groupId: 'group' }, file: entry, capabilities: ['files:read', 'files:write'] }),
  onContextChanged: () => () => {}, onLink: () => () => {}, setTabTitle: async () => {},
  linkTo: async ({ at }: { at: { lines: string } }) => `gugu-file://reachability#${at.lines}`,
  markdown: async () => ({ render: renderer(verbs) }),
  codemirror: async () => ({ EditorView: view.EditorView, EditorState: state.EditorState, basicSetup, markdown, markdownLanguage, view, state, language, lezerHighlight }),
  bind: { codemirror: (editor: view.EditorView) => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: file.text } });
    return () => {};
  } },
};
const ownStyle = document.createElement('style');
const byId = (id: string) => document.getElementById(id)!;
const handle = () => byId('block-handle') as HTMLButtonElement;

beforeAll(async () => {
  await page.viewport(1100, 760);
  ownStyle.textContent = appPaletteCss(tokensCss) + uiCss + workspaceCss;
  document.head.append(ownStyle);
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  Object.assign(window, { gugu });
  await import('@/session/app-runtime/ui/ui-entry');
  // @ts-expect-error — the built-in App is an unbundled ES module.
  await import('../../../../../preinstalled-apps/workspace/app.js');
  await until('the actual Workspace reading and source editor are ready', () => !!byId('preview').querySelector('p[data-line="3-3"]') && !!document.querySelector('.cm-editor'));
});

afterAll(() => {
  const editor = document.querySelector<HTMLElement>('.cm-editor');
  if (editor) view.EditorView.findFromDOM(editor)?.destroy();
  document.body.replaceChildren();
  ownStyle.remove();
});

async function pointer(x: number, y: number, type = 'mouseMoved', extra: Record<string, number> = {}) {
  // Same CDP coordinate mapping as the existing App UI/hover tests, including the test frame's scale.
  for (let current: Window = window; current.frameElement; current = current.parent) {
    const frame = current.frameElement as HTMLElement, box = frame.getBoundingClientRect();
    const scale = box.width / frame.offsetWidth;
    x = box.left + (frame.clientLeft + x) * scale;
    y = box.top + (frame.clientTop + y) * scale;
  }
  const session = cdp() as unknown as { send: (method: string, params: object) => Promise<unknown> };
  const click = type === 'mousePressed' || type === 'mouseReleased';
  await session.send('Input.dispatchMouseEvent', { type, x, y, button: click ? 'left' : 'none', buttons: type === 'mousePressed' ? 1 : 0, clickCount: click ? 1 : 0, ...extra });
}

async function openHandle() {
  const box = handle().getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
  expect(handle().contains(document.elementFromPoint(x, y)), 'the visible handle is the actual pointer target').toBe(true);
  await pointer(x, y);
  await pointer(x, y, 'mousePressed');
  await pointer(x, y, 'mouseReleased');
  await until('the real block menu opens', () => !byId('menu').hidden);
  const items = [...byId('menu').querySelectorAll('button')];
  expect(items.map((item) => item.textContent)).toEqual(['Cite in the chat', 'Keep to cite', 'Copy a link to it', 'Find in the source']);
  await userEvent.click(items[2]);
}

it('keeps the block through left padding, opens its menu, and changes only on another paragraph row', async () => {
  const preview = byId('preview');
  const first = preview.querySelector<HTMLElement>('p[data-line="3-3"]')!.getBoundingClientRect();
  await pointer(first.left + 50, first.top + first.height / 2);
  await until('paragraph actions appear', () => !handle().hidden);
  const placed = handle().getBoundingClientRect();
  const destination = { x: placed.left + placed.width / 2, y: placed.top + placed.height / 2 };
  for (let step = 1; step <= 30; step++) {
    await pointer(first.left + 50 + (destination.x - first.left - 50) * step / 30, first.top + first.height / 2 + (destination.y - first.top - first.height / 2) * step / 30);
    expect(handle().hidden, 'crossing the reading padding must not remove the handle').toBe(false);
    expect(handle().getBoundingClientRect().top).toBeCloseTo(placed.top);
  }
  await openHandle();
  await until('the first block link reaches the host clipboard', () => copied.at(-1) === 'gugu-file://reachability#3');
  expect(copied.at(-1)).toBe('gugu-file://reachability#3');

  const second = preview.querySelector<HTMLElement>('p[data-line="5-5"]')!.getBoundingClientRect();
  const gutter = preview.getBoundingClientRect().left + 2;
  expect(gutter).toBeLessThan(second.left);
  await pointer(gutter, second.top + second.height / 2);
  expect(handle().hidden).toBe(false);
  expect(handle().getBoundingClientRect().top).toBeCloseTo(second.top + 2);
  await openHandle();
  await until('the second block link reaches the host clipboard', () => copied.at(-1) === 'gugu-file://reachability#5');
  expect(copied.at(-1)).toBe('gugu-file://reachability#5');

  await pointer(first.left + 50, first.top + first.height / 2);
  await pointer(byId('doc-title').getBoundingClientRect().left + 10, byId('doc-title').getBoundingClientRect().top + 5);
  await until('leaving the preview and handle hides the actions', () => handle().hidden);
  await pointer(second.left + 50, second.top + second.height / 2);
  await until('returning to a paragraph restores the actions', () => !handle().hidden);
  await pointer(gutter, second.top, 'mouseWheel', { deltaX: 0, deltaY: 300 });
  await until('a real preview scroll hides the handle', () => preview.scrollTop > 0 && handle().hidden);
});
