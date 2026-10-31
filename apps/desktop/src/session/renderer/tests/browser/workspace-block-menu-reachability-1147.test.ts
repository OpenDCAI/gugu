import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import * as language from '@codemirror/language';
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import * as lezerHighlight from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import * as autocomplete from '@codemirror/autocomplete';
import * as Y from 'yjs';
import { yCollab } from 'y-codemirror.next';
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
const entry = { id: 'reachability', chat: 'group', name: 'reachability.md', path: 'notes/reachability.md', parentId: 'notes', type: 'text', contentType: 'text/markdown', sourceMessageIds: [] };
const text = '# Reading\n\nFirst paragraph keeps its own actions.\n\nSecond paragraph has different source lines.\n\n' + 'More reading below.\n\n'.repeat(40);
const ydoc = new Y.Doc();
const ytext = ydoc.getText('content');
ytext.insert(0, text);
let renders = 0;
const file = {
  entry, type: 'text', readOnly: false, status: 'online',
  get text() { return ytext.toString(); },
  anchor: (at: number) => Y.createRelativePositionFromTypeIndex(ytext, at),
  resolve: (anchor: Y.RelativePosition) => Y.createAbsolutePositionFromRelativePosition(anchor, ydoc)?.index ?? null,
  onChange: (fn: (event: { local: boolean }) => void) => {
    const changed = () => fn({ local: true });
    ytext.observe(changed);
    return () => ytext.unobserve(changed);
  },
  onStatus: () => () => {}, close: () => {},
  presence: { self: { userId: 'reader', color: '' }, others: [], onChange: () => () => {}, set: () => {} },
};
const copied: string[] = [];
const pictureId = '0b6d3a52-5a3e-4b70-9f0e-1d2c3b4a5f60';
const image = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>'], 'image [one].svg', { type: 'image/svg+xml' });
const picture = { ...entry, id: pictureId, type: 'binary', name: image.name, contentType: image.type };
const attachment = { ...entry, id: '0b6d3a52-5a3e-4b70-9f0e-1d2c3b4a5f61', type: 'binary', name: 'notes.pdf', contentType: 'application/pdf' };
const upload = vi.fn(async (_place: unknown) => [picture, attachment]);
const dispatch = vi.fn(async (_text: string, _options: unknown) => ({}));
const verbs = {
  openLink: async () => {}, openBrowserTab: async () => {}, reportError: async (message: string) => { throw new Error(message); },
  clipboard: { writeText: async (text: string) => { copied.push(text); } },
  files: {
    open: async (ref: unknown) => (ref as { id: string }).id === pictureId ? { type: 'binary', entry: picture, blob: async () => image } : file,
    readVersion: async () => file, onChanged: () => () => {}, upload,
    list: async () => [entry, picture, attachment],
  },
};
const gugu = {
  ...verbs,
  dispatch,
  getContext: async () => ({ locale: 'en', themeMode: 'light', chat: { id: 'group', name: 'Test group', kind: 'group', groupId: 'group' }, file: entry, capabilities: ['files:read', 'files:write'] }),
  onContextChanged: () => () => {}, onLink: () => () => {}, setTabTitle: async () => {},
  linkTo: async ({ at }: { at: { lines: string } }) => `gugu-file://reachability#${at.lines}`,
  markdown: async () => {
    const draw = renderer(verbs);
    return { render: (...args: Parameters<typeof draw>) => { draw(...args); renders++; } };
  },
  codemirror: async () => ({ EditorView: view.EditorView, EditorState: state.EditorState, basicSetup, markdown, markdownLanguage, view, state, language, autocomplete, lezerHighlight }),
  bind: { codemirror: (editor: view.EditorView) => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: file.text } });
    editor.dispatch({ effects: state.StateEffect.appendConfig.of(yCollab(ytext, null)) });
    return () => {};
  } },
};
const ownStyle = document.createElement('style');
const byId = (id: string) => document.getElementById(id)!;
const controls = () => byId('block-controls');
const handle = (id = 'block-insert') => byId(id) as HTMLButtonElement;
const editor = () => view.EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;

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

beforeEach(async () => {
  file.readOnly = false;
  const before = renders;
  editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: text } });
  await userEvent.keyboard('{Escape}');
  await userEvent.click(byId('mode-preview'));
  byId('preview').scrollTop = 0;
  await until('the original reading is redrawn', () => renders > before && !!byId('preview').querySelector('p[data-line="5-5"]') && !byId('preview').querySelector('table'));
  upload.mockClear();
  copied.length = 0;
  dispatch.mockClear();
});

afterAll(() => {
  const editor = document.querySelector<HTMLElement>('.cm-editor');
  if (editor) view.EditorView.findFromDOM(editor)?.destroy();
  document.body.replaceChildren();
  ownStyle.remove();
  ydoc.destroy();
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

async function openHandle(id = 'block-insert') {
  const box = handle(id).getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
  expect(handle(id).contains(document.elementFromPoint(x, y)), 'the visible handle is the actual pointer target').toBe(true);
  await pointer(x, y);
  await pointer(x, y, 'mousePressed');
  await pointer(x, y, 'mouseReleased');
  await until('the real block menu opens', () => !byId('menu').hidden);
  const items = [...byId('menu').querySelectorAll('button')];
  if (id === 'block-insert') {
    expect(handle().querySelector('gugu-icon')?.getAttribute('name')).toBe('plus');
    expect(items.map((item) => item.textContent)).toEqual(['Table', 'Image…', 'File…', 'Heading', 'List', 'To-do', 'Quote', 'Code block', 'Divider']);
  } else {
    expect(handle(id).textContent).toBe('⋮⋮');
    expect([...byId('menu').querySelectorAll(':scope > button, :scope > .menu-group > button')].map((item) => item.textContent)).toEqual(['Turn into ›', 'Duplicate', 'Move up', 'Move down', 'Delete', 'Copy link to block', 'Cite in chat']);
  }
}

it('keeps the block through left padding, opens its menu, and changes only on another paragraph row', async () => {
  const preview = byId('preview');
  const first = preview.querySelector<HTMLElement>('p[data-line="3-3"]')!.getBoundingClientRect();
  await pointer(first.left + 50, first.top + first.height / 2);
  await until('paragraph actions appear', () => !controls().hidden);
  const placed = handle().getBoundingClientRect();
  const destination = { x: placed.left + placed.width / 2, y: placed.top + placed.height / 2 };
  for (let step = 1; step <= 30; step++) {
    await pointer(first.left + 50 + (destination.x - first.left - 50) * step / 30, first.top + first.height / 2 + (destination.y - first.top - first.height / 2) * step / 30);
    expect(controls().hidden, 'crossing the reading padding must not remove the handle').toBe(false);
    expect(handle().getBoundingClientRect().top).toBeCloseTo(placed.top);
  }
  await openHandle();
  await userEvent.keyboard('{Escape}');
  const actionBox = handle('block-handle').getBoundingClientRect();
  for (let step = 1; step <= 20; step++) {
    await pointer(first.left + 50 + (actionBox.left + actionBox.width / 2 - first.left - 50) * step / 20, first.top + first.height / 2);
    expect(controls().hidden).toBe(false);
  }
  await openHandle('block-handle');
  await userEvent.keyboard('{Escape}');
  await openHandle();
  const title = byId('doc-title').getBoundingClientRect();
  await pointer(title.left + 10, title.top + 5);
  await pointer(title.left + 10, title.top + 5, 'mousePressed');
  await pointer(title.left + 10, title.top + 5, 'mouseReleased');
  await until('closing outside the reading restores the handle hide', () => controls().hidden);

  const second = preview.querySelector<HTMLElement>('p[data-line="5-5"]')!.getBoundingClientRect();
  const gutter = preview.getBoundingClientRect().left + 2;
  expect(gutter).toBeLessThan(second.left);
  expect(second.top).toBeGreaterThan(first.bottom);
  await pointer(first.left + 50, first.top + first.height / 2);
  await pointer(gutter, (first.bottom + second.top) / 2);
  expect(controls().hidden, 'a paragraph gap keeps the previous handle').toBe(false);
  expect(handle().getBoundingClientRect().top).toBeCloseTo(placed.top);
  await pointer(gutter, second.top + second.height / 2);
  expect(controls().hidden).toBe(false);
  expect(handle().getBoundingClientRect().top).toBeCloseTo(second.top + 2);
  await openHandle();
  await userEvent.keyboard('{Escape}');

  await pointer(first.left + 50, first.top + first.height / 2);
  await pointer(byId('doc-title').getBoundingClientRect().left + 10, byId('doc-title').getBoundingClientRect().top + 5);
  await until('leaving the preview and handle hides the actions', () => controls().hidden);
  await pointer(second.left + 50, second.top + second.height / 2);
  await until('returning to a paragraph restores the actions', () => !controls().hidden);
  await pointer(gutter, second.top, 'mouseWheel', { deltaX: 0, deltaY: 300 });
  await until('a real preview scroll hides the handle', () => preview.scrollTop > 0 && controls().hidden);
});

async function insertAtFirst(label: string) {
  const first = byId('preview').querySelector('p[data-line="3-3"]')!.getBoundingClientRect();
  await pointer(first.left + 40, first.top + first.height / 2);
  await until('the paragraph insertion button appears', () => !controls().hidden);
  await openHandle();
  await userEvent.click([...byId('menu').querySelectorAll('button')].find((button) => button.textContent === label)!);
}

it('inserts a 3×3 table after the paragraph, focuses its first cell in the source, and renders the edit', async () => {
  await insertAtFirst('Table');
  const table = '|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |';
  const at = text.indexOf('\n\nSecond paragraph');
  expect(editor().state.doc.toString()).toBe(`${text.slice(0, at)}\n\n${table}\n${text.slice(at)}`);
  expect(editor().state.selection.main.head).toBe(at + 4);
  expect(document.body.dataset.mode).toBe('split');
  await until('the table is drawn by the real preview', () => byId('preview').querySelectorAll('table tr').length === 3);
  expect([...byId('preview').querySelectorAll('table tr')].map((row) => row.children.length)).toEqual([3, 3, 3]);
  await userEvent.keyboard('First');
  expect(editor().state.doc.toString()).toContain('| First |  |  |');
  await until('typing at the focused caret reaches the first preview cell', () => byId('preview').querySelector('table th')?.textContent === 'First');
});

it('uses the existing picker/upload into this document’s folder and renders the uploaded image and file link', async () => {
  await insertAtFirst('Image…');
  const imageSource = `![image \\[one\\].svg](gugu-file://${pictureId})`;
  await until('the uploaded image is written through the bound source', () => file.text.includes(imageSource));
  expect(upload).toHaveBeenCalledExactlyOnceWith({ chat: 'group', folder: 'notes' });
  const at = text.indexOf('\n\nSecond paragraph');
  expect(editor().state.doc.toString()).toBe(`${text.slice(0, at)}\n\n${imageSource}\n\n[notes.pdf](gugu-file://${attachment.id})\n${text.slice(at)}`);
  expect(editor().state.selection.main.head).toBe(at + 2);
  expect(document.body.dataset.mode).toBe('split');
  await until('the uploaded file is read and painted by the real Markdown renderer', () => {
    const img = byId('preview').querySelector<HTMLImageElement>('img.gg-md-img');
    return !!img?.complete && img.naturalWidth === 16;
  });
  expect(byId('preview').querySelector(`a[href="gugu-file://${attachment.id}"]`)?.textContent).toContain('notes.pdf');
});

it('inserts a file as a folder link, including an image chosen through File', async () => {
  await insertAtFirst('File…');
  await until('the returned folder entries reach the source', () => file.text.includes(`gugu-file://${attachment.id}`));
  expect(file.text).toContain(`[image \\[one\\].svg](gugu-file://${pictureId})`);
  expect(file.text).not.toContain('![');
  await until('both file links are in the preview', () => !!byId('preview').querySelector(`a[href="gugu-file://${attachment.id}"]`));
  expect(byId('preview').querySelector('img.gg-md-img')).toBeNull();
});

it.each([
  ['Heading', '## ', 'h2'], ['List', '- ', 'ul li'], ['To-do', '- [ ] ', 'ul li'],
  ['Quote', '> ', 'blockquote'], ['Code block', '```\n\n```', 'pre'], ['Divider', '---\n', 'hr'],
])('inserts %s through + into the same Y.Text and preview', async (label, source, selector) => {
  await insertAtFirst(label);
  const at = text.indexOf('\n\nSecond paragraph');
  expect(file.text).toBe(`${text.slice(0, at)}\n\n${source}\n${text.slice(at)}`);
  expect(editor().state.doc.toString()).toBe(ytext.toString());
  if (label !== 'Divider') await userEvent.keyboard('Inserted');
  await until('the inserted block is rendered', () => {
    const node = byId('preview').querySelector(selector);
    return label === 'Divider' ? !!node : !!node?.textContent?.includes('Inserted');
  });
});

async function actOnParagraph(words: string, action: string, turn?: string) {
  const paragraph = [...byId('preview').querySelectorAll('p')].find((p) => p.textContent === words)!;
  const box = paragraph.getBoundingClientRect();
  await pointer(box.left + 30, box.top + box.height / 2);
  await until('the paragraph controls appear', () => !controls().hidden);
  await openHandle('block-handle');
  const button = [...byId('menu').querySelectorAll('button')].find((item) => item.textContent === (turn ? 'Turn into ›' : action))!;
  if (turn) {
    const at = button.getBoundingClientRect();
    await pointer(at.left + at.width / 2, at.top + at.height / 2);
    const submenu = button.parentElement!.querySelector('.menu-submenu')!;
    await userEvent.click([...submenu.querySelectorAll('button')].find((item) => item.textContent === turn)!);
  } else await userEvent.click(button);
}

it.each([
  ['Heading', '## First paragraph keeps its own actions.', 'h2'],
  ['List', '- First paragraph keeps its own actions.', 'ul li'],
  ['Quote', '> First paragraph keeps its own actions.', 'blockquote'],
  ['Code block', '```\nFirst paragraph keeps its own actions.\n```', 'pre'],
])('turns a paragraph into %s by replacing its source span', async (label, source, selector) => {
  await actOnParagraph('First paragraph keeps its own actions.', 'Turn into', label);
  expect(file.text).toBe(text.replace('First paragraph keeps its own actions.', source));
  await until('the converted block is drawn', () => !!byId('preview').querySelector(selector)?.textContent?.includes('First paragraph keeps its own actions.'));
  expect(file.text).toContain('Second paragraph has different source lines.');
});

it('copies the whole block link and cites that source span from the actions handle', async () => {
  const first = 'First paragraph keeps its own actions.';
  await actOnParagraph(first, 'Copy link to block');
  await until('the block link reaches the clipboard', () => copied.at(-1) === 'gugu-file://reachability#3');
  await actOnParagraph(first, 'Cite in chat');
  await until('the whole block is cited through the host', () => dispatch.mock.calls.length === 1);
  expect(dispatch.mock.calls[0]).toEqual(['', { draft: true, refs: [expect.objectContaining({ file: entry, at: expect.objectContaining({ lines: '3' }) })] }]);
});

it('moves, duplicates and deletes full source blocks without changing their neighbors', async () => {
  const first = 'First paragraph keeps its own actions.', second = 'Second paragraph has different source lines.';
  const paragraphOrder = () => [...byId('preview').querySelectorAll('p')].slice(0, 2).map((p) => p.textContent);
  await actOnParagraph(second, 'Move up');
  expect(file.text).toBe(text.replace(`${first}\n\n${second}`, `${second}\n\n${first}`));
  await until('the moved-up paragraph precedes the first', () => paragraphOrder()[0] === second);
  await actOnParagraph(second, 'Move down');
  expect(file.text).toBe(text);
  await until('the original paragraph order is restored', () => paragraphOrder()[0] === first);
  await actOnParagraph(first, 'Duplicate');
  expect(file.text).toBe(text.replace(first, `${first}\n\n${first}`));
  await until('the copied block is drawn before the old neighbor', () => paragraphOrder().every((p) => p === first));
  await actOnParagraph(first, 'Delete');
  expect(file.text).toBe(text);
  await until('deleting one copy restores the reading', () => paragraphOrder()[0] === first && paragraphOrder()[1] === second);
});

it('filters / on an empty source line and inserts the same Quote template', async () => {
  await userEvent.click(byId('mode-edit'));
  const at = editor().state.doc.length;
  editor().dispatch({ selection: { anchor: at } });
  editor().focus();
  await userEvent.keyboard('/quo');
  await until('the existing autocomplete filters to Quote', () => document.querySelectorAll('.cm-tooltip-autocomplete [role="option"]').length === 1 && document.querySelector('.cm-tooltip-autocomplete')?.textContent?.includes('Quote') === true);
  await userEvent.keyboard('{Enter}');
  expect(file.text).toBe(`${text}> \n`);
  expect(editor().state.selection.main.head).toBe(at + 2);
  await userEvent.keyboard('From slash');
  await userEvent.click(byId('mode-split'));
  await until('slash content is rendered from Y.Text', () => byId('preview').querySelector('blockquote')?.textContent?.includes('From slash') === true);
});

it('keeps an insertion attached to its paragraph while another editor changes Y.Text during the picker', async () => {
  let finish!: (entries: typeof picture[]) => void;
  upload.mockImplementationOnce(() => new Promise<typeof picture[]>((resolve) => { finish = resolve; }));
  await insertAtFirst('Image…');
  expect(upload).toHaveBeenCalledTimes(1);
  ydoc.transact(() => ytext.insert(0, 'Remote paragraph.\n\n'));
  finish([picture]);
  await until('the picker inserts after the shifted block', () => file.text.includes(`gugu-file://${pictureId}`));
  expect(file.text).toContain('Remote paragraph.\n\n# Reading\n\nFirst paragraph keeps its own actions.\n\n![image \\[one\\].svg]');
  expect(editor().state.doc.toString()).toBe(ytext.toString());
  await until('the collaborative insertion also reaches the preview', () => !!byId('preview').querySelector('img.gg-md-img'));
});

it('shows neither handle for a read-only document', async () => {
  file.readOnly = true;
  const first = byId('preview').querySelector('p[data-line="3-3"]')!.getBoundingClientRect();
  await pointer(first.left + 40, first.top + first.height / 2);
  expect(controls().hidden).toBe(true);
});
