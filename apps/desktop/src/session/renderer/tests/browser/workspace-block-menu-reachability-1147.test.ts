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
import { appContextMenuOf } from '@/session/shared/extensions/app-context-menu';
import type { ContentMenuItem } from '@/session/shared/content-context-menu';

// The shipped App, its actual Markdown renderer/CodeMirror and its shipped styles. Only the host's file/context API
// is supplied here; pointer input goes through Chromium, not dispatchEvent or direct show/hide calls. The App's menus
// are the host's (showContextMenu): here the host side takes the App's items through the real bridge parser and
// answers with the picked id, as a person's choice in the host's menu would (content-menu-submenus.test.tsx covers how
// the host draws them).
const entry = { id: 'reachability', chat: 'group', name: 'reachability.md', path: 'notes/reachability.md', parentId: 'notes', type: 'text', contentType: 'text/markdown', sourceMessageIds: [] };
const text = '# Reading\n\nFirst paragraph keeps its own actions.\n\nSecond paragraph has different source lines.\n\n' + 'More reading below.\n\n'.repeat(40);
const ydoc = new Y.Doc();
const ytext = ydoc.getText('content');
ytext.insert(0, text);
let renders = 0;
const file = {
  entry, type: 'text', readOnly: false, status: 'online',
  get text() { return ytext.toString(); },
  anchor: (at: number, assoc: -1 | 1 = 1) => Y.createRelativePositionFromTypeIndex(ytext, at, assoc < 0 ? -1 : 0),
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
type FolderEntry = Omit<typeof entry, 'contentType'> & { contentType?: string; clashWith?: string };
let folderEntries: FolderEntry[] = [entry, picture, attachment];
const upload = vi.fn(async (_place: unknown): Promise<FolderEntry[]> => [picture, attachment]);
const replace = vi.fn(async (_entry: unknown, _blob: unknown, _options: unknown) => {});
const remove = vi.fn(async (entry: { id: string }) => { folderEntries = folderEntries.filter((item) => item.id !== entry.id); });
const dispatch = vi.fn(async (_text: string, _options: unknown) => ({}));
const verbs = {
  openLink: async () => {}, openBrowserTab: async () => {}, reportError: async (message: string) => { throw new Error(message); },
  clipboard: { writeText: async (text: string) => { copied.push(text); } },
  files: {
    open: async (ref: unknown) => {
      const id = (ref as { id: string }).id;
      if (id === entry.id) return file;
      const found = folderEntries.find((item) => item.id === id);
      if (!found) throw new Error(`Unknown test file: ${id}`);
      return { type: 'binary', entry: found, blob: async () => image, close: () => {} };
    },
    readVersion: async () => file, onChanged: () => () => {}, upload, replace, remove,
    list: async () => folderEntries,
  },
};
type Row = Exclude<ContentMenuItem, { type: 'separator' }>;
let shown: { items: ContentMenuItem[]; resolve: (id: string | null) => void } | null = null;
const showContextMenu = (args: Record<string, unknown>) => {
  const menu = appContextMenuOf(args);
  shown?.resolve(null);
  return new Promise<string | null>((resolve) => { shown = { items: menu.items, resolve }; });
};
const rows = (items: ContentMenuItem[] = shown?.items ?? []) => items.filter((item): item is Row => item.type !== 'separator');
const labels = (items?: ContentMenuItem[]) => rows(items).map((row) => row.label);
const find = (label: string, items: ContentMenuItem[] = shown?.items ?? []): Row | undefined => {
  for (const row of rows(items)) {
    if (row.label === label) return row;
    const nested = row.items && find(label, row.items);
    if (nested) return nested;
  }
  return undefined;
};
const menuOpen = () => shown !== null;
const menuItem = (label: string) => find(label)!;
// One frame: the App's answer to the pick (its action, its focus) has run by then; frames are not faked below.
const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
// A person picks a row of the host's menu (inside the submenu named `within`): only an enabled leaf is an action.
async function pick(label: string, within?: string) {
  const row = find(label, within ? menuItem(within).items : undefined);
  expect(row, label).toBeDefined();
  expect(row!.items, `${label} is an action`).toBeUndefined();
  expect(row!.enabled, `${label} is enabled`).not.toBe(false);
  const open = shown!;
  shown = null;
  open.resolve(row!.id);
  await settle();
}
// Escape or a press elsewhere in the host's menu.
async function dismiss() {
  const open = shown;
  shown = null;
  open?.resolve(null);
  await settle();
}
const gugu = {
  ...verbs,
  dispatch,
  showContextMenu,
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
// One read/edit toggle (owner 11-06): the button a press goes to is the one shown; the current mode's and 对照's (a ⋯ item)
// are hidden. A shown one is pressed as a person would; a hidden one is the page's own mode change.
const toMode = async (mode: 'edit' | 'preview' | 'split') => {
  const button = byId(`mode-${mode}`);
  if (button.hidden) button.click();
  else await userEvent.click(button);
};
const shownToggle = () => [...document.querySelectorAll<HTMLButtonElement>('.modes > button')].find((button) => !button.hidden)!;
const controls = () => byId('block-controls');
const handle = (id = 'block-handle') => byId(id) as HTMLButtonElement;
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
  folderEntries = [entry, picture, attachment];
  const before = renders;
  editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: text } });
  await userEvent.keyboard('{Escape}');
  await toMode('split');
  const preview = byId('preview');
  if (preview.scrollTop !== 0) {
    const settled = new Promise<Event>((resolve) => preview.addEventListener('scroll', resolve, { once: true }));
    preview.scrollTop = 0;
    await settled;
  }
  await until('the original reading is redrawn', () => renders > before && !!byId('preview').querySelector('p[data-line="5-5"]') && !byId('preview').querySelector('table'));
  upload.mockClear();
  copied.length = 0;
  dispatch.mockClear();
  replace.mockClear();
  remove.mockClear();
});

afterAll(() => {
  const editor = document.querySelector<HTMLElement>('.cm-editor');
  if (editor) view.EditorView.findFromDOM(editor)?.destroy();
  ownStyle.remove();
  ydoc.destroy();
});

async function pointer(x: number, y: number, type = 'mouseMoved', extra: Record<string, string | number> = {}) {
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
  await new Promise<void>((done) => requestAnimationFrame(() => done()));
}

async function openHandle(insertion = true) {
  const box = handle().getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
  expect(handle().contains(document.elementFromPoint(x, y)), 'the visible handle is the actual pointer target').toBe(true);
  expect(document.getElementById('block-insert')).toBeNull();
  expect(controls().querySelectorAll('button')).toHaveLength(1);
  expect(handle().querySelector('gugu-icon')?.getAttribute('name')).toBe('more-horizontal');
  expect(handle().querySelector('gugu-icon')?.shadowRoot?.querySelector('svg'), 'the built-in icon really renders').not.toBeNull();
  await pointer(x, y);
  await pointer(x, y, 'mousePressed');
  await pointer(x, y, 'mouseReleased');
  await until('the block menu opens in the host', menuOpen);
  expect(shown!.items.filter((item) => item.type === 'separator')).toHaveLength(1);
  expect(labels()).toEqual(['Insert below this paragraph', 'Turn into', 'Duplicate', 'Move up', 'Move down', 'Delete', 'Copy link to block', 'Cite']);
  // Each kind of block is named once per submenu; Quote and Code block are in both because both are what they say.
  expect(labels(menuItem('Turn into').items)).toEqual(['Heading', 'List', 'Quote', 'Code block']);
  if (insertion) expect(labels(menuItem('Insert below this paragraph').items)).toEqual(['Table', 'Image…', 'File…', 'Heading', 'List', 'To-do', 'Quote', 'Code block', 'Divider']);
}

async function readMenu() {
  await toMode('preview');
  const box = byId('preview').querySelector('p[data-line="3-3"]')!.getBoundingClientRect();
  await pointer(box.left + 30, box.top + box.height / 2);
  expect(controls().hidden).toBe(true);
  await pointer(box.left + 30, box.top + box.height / 2, 'mousePressed', { button: 'right', buttons: 2 });
  await pointer(box.left + 30, box.top + box.height / 2, 'mouseReleased', { button: 'right' });
  await until('reading right-click offers the existing block links', menuOpen);
  expect(labels()).toEqual(['Copy link to block', 'Cite']);
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
  await dismiss();
  const actionBox = handle('block-handle').getBoundingClientRect();
  for (let step = 1; step <= 20; step++) {
    await pointer(first.left + 50 + (actionBox.left + actionBox.width / 2 - first.left - 50) * step / 20, first.top + first.height / 2);
    expect(controls().hidden).toBe(false);
  }
  await openHandle(false);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await dismiss();
    vi.runOnlyPendingTimers();
  } finally {
    vi.useRealTimers();
  }
  expect(controls().hidden, 'Escape keeps the handle under the resting pointer').toBe(false);
  await openHandle();
  const title = byId('doc-title').getBoundingClientRect();
  await pointer(title.left + 10, title.top + 5);
  await pointer(title.left + 10, title.top + 5, 'mousePressed');
  await pointer(title.left + 10, title.top + 5, 'mouseReleased');
  await dismiss();
  await until('closing outside the reading restores the handle hide', () => controls().hidden === true);

  const second = preview.querySelector<HTMLElement>('p[data-line="5-5"]')!.getBoundingClientRect();
  const gutter = preview.getBoundingClientRect().left + 2;
  expect(gutter).toBeLessThan(second.left);
  expect(second.top).toBeGreaterThan(first.bottom);
  await pointer(first.left + 50, first.top + first.height / 2);
  await pointer(gutter, (first.bottom + second.top) / 2);
  expect(controls().hidden, 'a paragraph gap keeps the previous handle').toBe(false);
  expect(handle().getBoundingClientRect().top).toBeCloseTo(placed.top);
  await pointer(second.left + 20, second.top + second.height / 2);
  expect(controls().hidden).toBe(false);
  expect(handle().getBoundingClientRect().top).toBeCloseTo(second.top + 2);
  await openHandle();
  await dismiss();

  await pointer(first.left + 50, first.top + first.height / 2);
  await pointer(byId('doc-title').getBoundingClientRect().left + 10, byId('doc-title').getBoundingClientRect().top + 5);
  await until('leaving the preview and handle hides the actions', () => controls().hidden === true);
  await pointer(second.left + 50, second.top + second.height / 2);
  await until('returning to a paragraph restores the actions', () => !controls().hidden);
  await pointer(gutter, second.top, 'mouseWheel', { deltaX: 0, deltaY: 300 });
  await until('a real preview scroll hides the handle', () => preview.scrollTop > 0 && controls().hidden === true);
});

async function insertAtFirst(label: string) {
  const first = byId('preview').querySelector('p[data-line="3-3"]')!.getBoundingClientRect();
  await pointer(first.left + 40, first.top + first.height / 2);
  await until('the single paragraph control appears', () => !controls().hidden);
  await openHandle();
  await pick(label, 'Insert below this paragraph');
}

it('inserts a 3×3 table after the paragraph, focuses its first cell in the source, and renders the edit', async () => {
  await insertAtFirst('Table');
  const table = '|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |';
  const at = text.indexOf('\n\nSecond paragraph');
  expect(editor().state.doc.toString()).toBe(`${text.slice(0, at)}\n\n${table}${text.slice(at)}`);
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
  expect(editor().state.doc.toString()).toBe(`${text.slice(0, at)}\n\n${imageSource}\n\n[notes.pdf](gugu-file://${attachment.id})${text.slice(at)}`);
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
  ['Quote', '> ', 'blockquote'], ['Code block', '```\n\n```', 'pre'], ['Divider', '***', 'hr'],
])('inserts %s through the one block menu into the same Y.Text and preview', async (label, source, selector) => {
  await insertAtFirst(label);
  const at = text.indexOf('\n\nSecond paragraph');
  expect(file.text).toBe(`${text.slice(0, at)}\n\n${source}${text.slice(at)}`);
  expect(editor().state.doc.toString()).toBe(ytext.toString());
  if (label !== 'Divider') await userEvent.keyboard('Inserted');
  await until('the inserted block is rendered', () => {
    const node = byId('preview').querySelector(selector);
    return label === 'Divider' ? !!node : !!node?.textContent?.includes('Inserted');
  });
});

async function paragraphMenu(words: string) {
  const paragraph = [...byId('preview').querySelectorAll('p')].find((p) => p.textContent === words)!;
  const box = paragraph.getBoundingClientRect();
  await pointer(box.left + 30, box.top + box.height / 2);
  await until('the paragraph controls appear', () => !controls().hidden);
  await openHandle(false);
}

async function actOnParagraph(words: string, action: string, turn?: string) {
  await paragraphMenu(words);
  await (turn ? pick(turn, action) : pick(action));
}

it.each([
  ['Heading', '## First paragraph keeps its own actions.', 'h2'],
  ['List', '- First paragraph keeps its own actions.', 'ul li'],
  ['Quote', '> First paragraph keeps its own actions.', 'blockquote'],
  ['Code block', '```\nFirst paragraph keeps its own actions.\n```', 'pre'],
])('turns a paragraph into %s by changing only its source markers', async (label, source, selector) => {
  await actOnParagraph('First paragraph keeps its own actions.', 'Turn into', label);
  expect(file.text).toBe(text.replace('First paragraph keeps its own actions.', source));
  await until('the converted block is drawn', () => !!byId('preview').querySelector(selector)?.textContent?.includes('First paragraph keeps its own actions.'));
  expect(file.text).toContain('Second paragraph has different source lines.');
});

async function showSource(source: string) {
  const before = renders;
  editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: source } });
  await toMode('split');
  await until('the new source is rendered', () => renders > before && file.text === source);
}

it.each([
  '| a | b |\n| - | - |\n| 1 | 2 |',
  '[ref]: https://example.com',
])('uses syntax neighbors when deleting or moving above %s', async (neighbor) => {
  const source = `Before.\n\n${neighbor}\n\nAfter.`;
  await showSource(source);
  await actOnParagraph('Before.', 'Delete');
  expect(file.text).toBe(`${neighbor}\n\nAfter.`);
  await showSource(source);
  await actOnParagraph('Before.', 'Move down');
  expect(file.text).toBe(`${neighbor}\n\nBefore.\n\nAfter.`);
});

it('keeps front matter fixed and exposes handles on table and rendered diagram wrappers', async () => {
  const source = '---\ntitle: Test\n---\n\nFirst.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```mermaid\ngraph TD; A-->B\n```';
  await showSource(source);
  const props = byId('preview').querySelector('.gg-md-props')!.getBoundingClientRect();
  await pointer(props.left + 30, props.top + props.height / 2);
  expect(controls().hidden).toBe(true);
  await paragraphMenu('First.');
  expect(menuItem('Move up').enabled).toBe(false);
  await dismiss();
  for (const [selector, lines] of [['.gg-md-table-scroll', '7-9'], ['.gg-md-mermaid', '11-13']] as const) {
    await until('the real wrapper has its source lines', () => byId('preview').querySelector(selector)?.getAttribute('data-line') === lines);
    const box = byId('preview').querySelector(selector)!.getBoundingClientRect();
    await pointer(box.left + 30, box.top + box.height / 2);
    expect(controls().hidden).toBe(false);
    await openHandle();
    await dismiss();
  }
  expect(file.text).toBe(source);
});

it('does not absorb a collaborator’s new paragraph appended at the old block end', async () => {
  await paragraphMenu('First paragraph keeps its own actions.');
  const at = file.text.indexOf('\n\nSecond paragraph');
  const before = renders;
  ydoc.transact(() => ytext.insert(at, '\n\nRemote paragraph.'));
  await until('the collaborative preview redraws while its block menu stays open', () => renders > before);
  expect(menuOpen()).toBe(true);
  await pick('Delete');
  expect(file.text).toBe(text.replace('First paragraph keeps its own actions.\n\n', 'Remote paragraph.\n\n'));
});

it('converts with marker edits and moves without replacing the neighboring Y.Text characters', async () => {
  const first = 'First paragraph keeps its own actions.', second = 'Second paragraph has different source lines.';
  await paragraphMenu(first);
  const word = file.anchor(file.text.indexOf('First'));
  const at = file.text.indexOf('\n\nSecond paragraph');
  ydoc.transact(() => ytext.insert(at, ' From another editor.'));
  await pick('Heading', 'Turn into');
  expect(file.text).toContain(`## ${first} From another editor.`);
  expect(file.text.slice(file.resolve(word)!, file.resolve(word)! + 5)).toBe('First');
  await showSource(text);
  const neighborWord = file.anchor(file.text.indexOf('Second'));
  await actOnParagraph(first, 'Move down');
  expect(file.text).toBe(text.replace(`${first}\n\n${second}`, `${second}\n\n${first}`));
  expect(file.text.slice(file.resolve(neighborWord)!, file.resolve(neighborWord)! + 6)).toBe('Second');
});

it('waits for a name conflict and inserts the surviving old file id after Replace', async () => {
  const newId = '0b6d3a52-5a3e-4b70-9f0e-1d2c3b4a5f62';
  const arrived = { ...picture, id: newId, clashWith: picture.id };
  upload.mockImplementationOnce(async () => { folderEntries.push(arrived); return [arrived]; });
  await insertAtFirst('Image…');
  await until('the existing name question appears', () => !byId('conflicts').hidden);
  expect(file.text).toBe(text);
  await userEvent.click([...byId('conflicts').querySelectorAll('button')].find((item) => item.textContent === 'Replace the old one')!);
  await until('the surviving file is referenced', () => file.text.includes(`gugu-file://${pictureId}`));
  expect(file.text).not.toContain(newId);
  expect(replace).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith(arrived);
});

it('treats an upload without contentType as a file link and reports picker failures in the banner', async () => {
  upload.mockResolvedValueOnce([{ ...attachment, contentType: undefined }]);
  await insertAtFirst('Image…');
  await until('a missing MIME type still inserts a link', () => file.text.includes(`[notes.pdf](gugu-file://${attachment.id})`));
  expect(file.text).not.toContain('![');
  await showSource(text);
  upload.mockRejectedValueOnce(new Error('Picker denied'));
  await insertAtFirst('Image…');
  await until('the failure is visible', () => byId('banner').textContent?.includes('Picker denied') === true);
  expect(file.text).toBe(text);
});

it('slash divider after a paragraph remains a divider and whitespace ends slash completion', async () => {
  await showSource('Paragraph.\n');
  await toMode('edit');
  editor().dispatch({ selection: { anchor: editor().state.doc.length } });
  editor().focus();
  await userEvent.keyboard('/div');
  await until('the slash menu filters to Divider', () => document.querySelectorAll('.cm-tooltip-autocomplete [role="option"]').length === 1 && document.querySelector('.cm-tooltip-autocomplete')?.textContent?.includes('Divider') === true);
  await userEvent.click(document.querySelector('.cm-tooltip-autocomplete [role="option"]')!);
  expect(file.text).toBe('Paragraph.\n***\n');
  await toMode('split');
  await until('the paragraph is not converted into a setext heading', () => !!byId('preview').querySelector('hr') && byId('preview').querySelector('p')?.textContent === 'Paragraph.');
  await showSource('\n');
  await toMode('edit');
  editor().dispatch({ selection: { anchor: 0 } });
  editor().focus();
  await userEvent.keyboard('/quo ');
  await until('whitespace closes slash suggestions', () => !document.querySelector('.cm-tooltip-autocomplete'));
});

it('keeps keyboard focus on the handle after Escape until focus leaves it', async () => {
  const first = byId('preview').querySelector('p[data-line="3-3"]')!.getBoundingClientRect();
  await pointer(first.left + 30, first.top + first.height / 2);
  handle('block-handle').focus();
  await userEvent.keyboard('{Enter}');
  await until('keyboard opens the block menu', menuOpen);
  const title = byId('doc-title').getBoundingClientRect();
  await pointer(title.left + 10, title.top + 5);
  await dismiss();
  expect(document.activeElement).toBe(handle('block-handle'));
  expect(controls().hidden).toBe(false);
  shownToggle().focus();
  await until('focus leaving restores hiding', () => controls().hidden === true);
});

it.each(['Delete', 'Move down', 'Heading'])('rejects %s after a collaborator deletes the selected block and separators', async (action) => {
  const first = 'First paragraph keeps its own actions.';
  await paragraphMenu(first);
  const from = file.text.indexOf(first), to = file.text.indexOf('Second paragraph');
  ydoc.transact(() => ytext.delete(from, to - from));
  const after = file.text;
  if (action === 'Heading') {
    await pick('Heading', 'Turn into');
  } else await pick(action);
  await until('the stale action has a visible repair message', () => byId('banner').textContent?.includes('Choose an insertion point again') === true);
  expect(file.text).toBe(after);
  expect(file.text).toContain('Second paragraph has different source lines.');
});

it('turns a multi-line paragraph into one heading while preserving each content character', async () => {
  await showSource('One line\nnext line\nlast line.\n\nAfter.');
  const first = byId('preview').querySelector('p')!;
  await actOnParagraph(first.textContent!, 'Turn into', 'Heading');
  expect(file.text).toBe('## One line next line last line.\n\nAfter.');
  await until('there is exactly one heading', () => byId('preview').querySelectorAll('h2').length === 1 && byId('preview').querySelector('h2')?.textContent === 'One line next line last line.');
});

it('does not offer a partial-block action when math preview spans disagree with the source parser', async () => {
  await showSource('Before.\n\n$$\na+b\n\nc+d\n$$\n\nAfter.');
  const math = byId('preview').querySelector('[data-line="3-7"]')!.getBoundingClientRect();
  await pointer(math.left + 20, math.top + math.height / 2);
  expect(controls().hidden).toBe(true);
  await paragraphMenu('After.');
  expect(controls().hidden).toBe(false);
});

it.each([
  ['- One\n- Two', 'List', '- One\n- Two\n- ', 1],
  ['* [ ] One\n* [x] Two', 'To-do', '* [ ] One\n* [x] Two\n* [ ] ', 1],
  ['- One\n- Two', 'To-do', '- One\n- Two\n\n* [ ] ', 2],
  ['- [ ] One\n- [x] Two', 'List', '- [ ] One\n- [x] Two\n\n* ', 2],
  ['1. One\n2. Two', 'List', '1. One\n2. Two\n\n- ', 2],
] as const)('inserts %s → %s with the agreed list continuation or separation', async (source, label, expected, count) => {
  await showSource(source + '\n\nAfter.');
  const list = byId('preview').querySelector('ul[data-line], ol[data-line]')!.getBoundingClientRect();
  await pointer(list.left + 25, list.top + 8);
  await openHandle();
  await pick(label, 'Insert below this paragraph');
  expect(file.text).toBe(expected + '\n\nAfter.');
  expect(editor().state.selection.main.head).toBe(expected.length);
  await userEvent.keyboard('Added');
  await until('the source is rendered as the requested number of lists', () => byId('preview').querySelectorAll('.gg-md > ul, .gg-md > ol').length === count && byId('preview').textContent?.includes('Added') === true);
});

it('releases mouse-menu focus and keeps focus in the reading when scrolling hides controls', async () => {
  await paragraphMenu('First paragraph keeps its own actions.');
  const title = byId('doc-title').getBoundingClientRect();
  await pointer(title.left + 10, title.top + 5);
  await dismiss();
  expect(document.activeElement).toBe(byId('preview'));
  await until('the mouse menu cannot pin the handles after leaving', () => controls().hidden === true);
  const paragraph = byId('preview').querySelector('p[data-line="3-3"]')!.getBoundingClientRect();
  await pointer(paragraph.left + 30, paragraph.top + 5);
  handle('block-handle').focus();
  byId('preview').scrollTop = 200;
  await until('scroll hides the focused controls', () => controls().hidden === true);
  expect(document.activeElement).toBe(byId('preview'));
});

it.each([['Heading', '## '], ['List', '- '], ['Quote', '> ']])('turns an empty code block into an editable %s template', async (label, expected) => {
  await showSource('```\n```\n\nAfter.');
  const box = byId('preview').querySelector('.gg-md-code')!.getBoundingClientRect();
  await pointer(box.left + 30, box.top + box.height / 2);
  await openHandle(false);
  await pick(label, 'Turn into');
  expect(file.text).toBe(expected + '\n\nAfter.');
  expect(editor().state.selection.main.head).toBe(expected.length);
  await userEvent.keyboard('Ready');
  expect(file.text).toBe(expected + 'Ready\n\nAfter.');
});

it('copies the whole block link and cites that source span from the actions handle', async () => {
  const first = 'First paragraph keeps its own actions.';
  await actOnParagraph(first, 'Copy link to block');
  await until('the block link reaches the clipboard', () => copied.at(-1) === 'gugu-file://reachability#3');
  await actOnParagraph(first, 'Cite');
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
  await toMode('edit');
  const at = editor().state.doc.length;
  editor().dispatch({ selection: { anchor: at } });
  editor().focus();
  await userEvent.keyboard('/quo');
  await until('the existing autocomplete filters to Quote', () => document.querySelectorAll('.cm-tooltip-autocomplete [role="option"]').length === 1 && document.querySelector('.cm-tooltip-autocomplete')?.textContent?.includes('Quote') === true);
  await userEvent.click(document.querySelector('.cm-tooltip-autocomplete [role="option"]')!);
  expect(file.text).toBe(`${text}> \n`);
  expect(editor().state.selection.main.head).toBe(at + 2);
  await userEvent.keyboard('From slash');
  await toMode('split');
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

it('keeps reading clean and offers block links on right-click', async () => {
  await readMenu();
  await pick('Copy link to block');
  await until('the reading block link is copied', () => copied.at(-1) === 'gugu-file://reachability#3');
  await readMenu();
  await pick('Cite');
  await until('reading cites the original source span', () => dispatch.mock.calls.length === 1);
  expect(dispatch.mock.calls[0]).toEqual(['', { draft: true, refs: [expect.objectContaining({ file: entry, at: expect.objectContaining({ lines: '3' }) })] }]);
  expect(file.text).toBe(text);
});

it('leaves a reading selection with its own bar when it is pressed for a menu', async () => {
  await toMode('preview');
  const box = byId('preview').querySelector('p[data-line="3-3"]')!.getBoundingClientRect();
  const [x, y] = [box.left + 30, box.top + box.height / 2];
  await pointer(x, y, 'mousePressed', { clickCount: 2 });
  await pointer(x, y, 'mouseReleased', { clickCount: 2 });
  await until('the pressed word is selected with its bar', () => !byId('sel-bar').hidden && !!document.getSelection()?.toString());
  await pointer(x, y, 'mousePressed', { button: 'right', buttons: 2 });
  await pointer(x, y, 'mouseReleased', { button: 'right' });
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(menuOpen()).toBe(false);
  expect([...byId('sel-bar').querySelectorAll('button:not(.fmt)')].map((item) => item.textContent)).toEqual(['Copy', 'Cite', '+ Keep']);
});

it('keeps every side control hidden for a read-only document, with reading links still usable', async () => {
  file.readOnly = true;
  for (const mode of ['preview', 'edit', 'split'] as const) {
    await toMode(mode);
    expect(controls().hidden).toBe(true);
  }
  await readMenu();
  await pick('Copy link to block');
  await until('the read-only block link is copied', () => copied.at(-1) === 'gugu-file://reachability#3');
  await readMenu();
  await pick('Cite');
  await until('the read-only source span is cited', () => dispatch.mock.calls.length === 1);
  expect(file.text).toBe(text);
});

it('keeps the single editing control outside the text in narrow source and side-by-side views', async () => {
  try {
    for (const [mode, width] of [['edit', 480], ['split', 1100]] as const) {
      await page.viewport(width, 760);
      await toMode(mode);
      const paragraph = (mode === 'edit' ? [...byId('editor').querySelectorAll<HTMLElement>('.cm-line')].find((line) => line.textContent === 'First paragraph keeps its own actions.')! : byId('preview').querySelector<HTMLElement>('p[data-line="3-3"]')!).getBoundingClientRect();
      await pointer(paragraph.left + 40, paragraph.top + paragraph.height / 2);
      await until('the single block control appears beside the paragraph', () => !controls().hidden);
      expect(controls().getBoundingClientRect().right, `${mode}: controls must not cover the paragraph`).toBeLessThan(paragraph.left);
      await openHandle(false);
      await dismiss();
    }
  } finally {
    await page.viewport(1100, 760);
    await toMode('split');
  }
});
