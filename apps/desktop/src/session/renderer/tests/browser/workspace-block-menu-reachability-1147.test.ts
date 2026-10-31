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
    open: async (ref: unknown) => (ref as { id: string }).id !== entry.id ? { type: 'binary', entry: ref, blob: async () => image, close: () => {} } : file,
    readVersion: async () => file, onChanged: () => () => {}, upload, replace, remove,
    list: async () => folderEntries,
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
  folderEntries = [entry, picture, attachment];
  const before = renders;
  editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: text } });
  await userEvent.keyboard('{Escape}');
  await userEvent.click(byId('mode-preview'));
  byId('preview').scrollTop = 0;
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
    expect([...byId('menu').querySelectorAll(':scope > button, :scope > .menu-group > button')].map((item) => item.textContent)).toEqual(file.readOnly ? ['Copy link to block', 'Cite in chat'] : ['Turn into ›', 'Duplicate', 'Move up', 'Move down', 'Delete', 'Copy link to block', 'Cite in chat']);
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
])('inserts %s through + into the same Y.Text and preview', async (label, source, selector) => {
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
  await openHandle('block-handle');
}

async function actOnParagraph(words: string, action: string, turn?: string) {
  await paragraphMenu(words);
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
])('turns a paragraph into %s by changing only its source markers', async (label, source, selector) => {
  await actOnParagraph('First paragraph keeps its own actions.', 'Turn into', label);
  expect(file.text).toBe(text.replace('First paragraph keeps its own actions.', source));
  await until('the converted block is drawn', () => !!byId('preview').querySelector(selector)?.textContent?.includes('First paragraph keeps its own actions.'));
  expect(file.text).toContain('Second paragraph has different source lines.');
});

async function showSource(source: string) {
  const before = renders;
  editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: source } });
  await userEvent.click(byId('mode-preview'));
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
  expect([...byId('menu').querySelectorAll('button')].find((item) => item.textContent === 'Move up')?.disabled).toBe(true);
  await userEvent.keyboard('{Escape}');
  for (const [selector, lines] of [['.gg-md-table-scroll', '7-9'], ['.gg-md-mermaid', '11-13']] as const) {
    await until('the real wrapper has its source lines', () => byId('preview').querySelector(selector)?.getAttribute('data-line') === lines);
    const box = byId('preview').querySelector(selector)!.getBoundingClientRect();
    await pointer(box.left + 30, box.top + box.height / 2);
    expect(controls().hidden).toBe(false);
    await openHandle();
    await userEvent.keyboard('{Escape}');
  }
  expect(file.text).toBe(source);
});

it('does not absorb a collaborator’s new paragraph appended at the old block end', async () => {
  await paragraphMenu('First paragraph keeps its own actions.');
  const at = file.text.indexOf('\n\nSecond paragraph');
  ydoc.transact(() => ytext.insert(at, '\n\nRemote paragraph.'));
  await userEvent.click([...byId('menu').querySelectorAll('button')].find((item) => item.textContent === 'Delete')!);
  expect(file.text).toBe(text.replace('First paragraph keeps its own actions.\n\n', 'Remote paragraph.\n\n'));
});

it('converts with marker edits and moves without replacing the neighboring Y.Text characters', async () => {
  const first = 'First paragraph keeps its own actions.', second = 'Second paragraph has different source lines.';
  await paragraphMenu(first);
  const word = file.anchor(file.text.indexOf('First'));
  const at = file.text.indexOf('\n\nSecond paragraph');
  ydoc.transact(() => ytext.insert(at, ' From another editor.'));
  const turn = [...byId('menu').querySelectorAll('button')].find((item) => item.textContent === 'Turn into ›')!;
  const rect = turn.getBoundingClientRect();
  await pointer(rect.left + rect.width / 2, rect.top + rect.height / 2);
  await userEvent.click([...turn.parentElement!.querySelectorAll('.menu-submenu button')].find((item) => item.textContent === 'Heading')!);
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
  await userEvent.click(byId('mode-edit'));
  editor().dispatch({ selection: { anchor: editor().state.doc.length } });
  editor().focus();
  await userEvent.keyboard('/div');
  await until('Divider is offered', () => document.querySelector('.cm-tooltip-autocomplete')?.textContent?.includes('Divider') === true);
  await userEvent.keyboard('{Enter}');
  expect(file.text).toBe('Paragraph.\n***\n');
  await userEvent.click(byId('mode-split'));
  await until('the paragraph is not converted into a setext heading', () => !!byId('preview').querySelector('hr') && byId('preview').querySelector('p')?.textContent === 'Paragraph.');
  await showSource('\n');
  await userEvent.click(byId('mode-edit'));
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
  await until('keyboard opens the block menu', () => !byId('menu').hidden);
  const title = byId('doc-title').getBoundingClientRect();
  await pointer(title.left + 10, title.top + 5);
  await userEvent.keyboard('{Escape}');
  expect(document.activeElement).toBe(handle('block-handle'));
  expect(controls().hidden).toBe(false);
  byId('mode-edit').focus();
  await until('focus leaving restores hiding', () => controls().hidden);
});

it.each(['Delete', 'Move down', 'Heading'])('rejects %s after a collaborator deletes the selected block and separators', async (action) => {
  const first = 'First paragraph keeps its own actions.';
  await paragraphMenu(first);
  const from = file.text.indexOf(first), to = file.text.indexOf('Second paragraph');
  ydoc.transact(() => ytext.delete(from, to - from));
  const after = file.text;
  if (action === 'Heading') {
    const turn = [...byId('menu').querySelectorAll('button')].find((item) => item.textContent === 'Turn into ›')!;
    const box = turn.getBoundingClientRect();
    await pointer(box.left + box.width / 2, box.top + box.height / 2);
    await userEvent.click([...turn.parentElement!.querySelectorAll('.menu-submenu button')].find((item) => item.textContent === 'Heading')!);
  } else await userEvent.click([...byId('menu').querySelectorAll('button')].find((item) => item.textContent === action)!);
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
  await userEvent.click([...byId('menu').querySelectorAll('button')].find((item) => item.textContent === label)!);
  expect(file.text).toBe(expected + '\n\nAfter.');
  expect(editor().state.selection.main.head).toBe(expected.length);
  await userEvent.keyboard('Added');
  await until('the source is rendered as the requested number of lists', () => byId('preview').querySelectorAll('.gg-md > ul, .gg-md > ol').length === count && byId('preview').textContent?.includes('Added') === true);
});

it('releases mouse-menu focus and keeps focus in the reading when scrolling hides controls', async () => {
  await paragraphMenu('First paragraph keeps its own actions.');
  const title = byId('doc-title').getBoundingClientRect();
  await pointer(title.left + 10, title.top + 5);
  await userEvent.keyboard('{Escape}');
  expect(document.activeElement).toBe(byId('preview'));
  await until('the mouse menu cannot pin the handles after leaving', () => controls().hidden);
  const paragraph = byId('preview').querySelector('p[data-line="3-3"]')!.getBoundingClientRect();
  await pointer(paragraph.left + 30, paragraph.top + 5);
  handle('block-handle').focus();
  byId('preview').scrollTop = 200;
  await until('scroll hides the focused controls', () => controls().hidden);
  expect(document.activeElement).toBe(byId('preview'));
});

it.each([['Heading', '## '], ['List', '- '], ['Quote', '> ']])('turns an empty code block into an editable %s template', async (label, expected) => {
  await showSource('```\n```\n\nAfter.');
  const box = byId('preview').querySelector('.gg-md-code')!.getBoundingClientRect();
  await pointer(box.left + 30, box.top + box.height / 2);
  await openHandle('block-handle');
  const turn = [...byId('menu').querySelectorAll('button')].find((item) => item.textContent === 'Turn into ›')!;
  const at = turn.getBoundingClientRect();
  await pointer(at.left + at.width / 2, at.top + at.height / 2);
  await userEvent.click([...turn.parentElement!.querySelectorAll('.menu-submenu button')].find((item) => item.textContent === label)!);
  expect(file.text).toBe(expected + '\n\nAfter.');
  expect(editor().state.selection.main.head).toBe(expected.length);
  await userEvent.keyboard('Ready');
  expect(file.text).toBe(expected + 'Ready\n\nAfter.');
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

it('keeps only link and whole-block citation actions for a read-only document', async () => {
  file.readOnly = true;
  const first = byId('preview').querySelector('p[data-line="3-3"]')!.getBoundingClientRect();
  await pointer(first.left + 40, first.top + first.height / 2);
  expect(controls().hidden).toBe(false);
  expect(handle().hidden).toBe(true);
  await openHandle('block-handle');
  await userEvent.click([...byId('menu').querySelectorAll('button')].find((button) => button.textContent === 'Copy link to block')!);
  await until('the read-only block link is copied', () => copied.at(-1) === 'gugu-file://reachability#3');
  await actOnParagraph('First paragraph keeps its own actions.', 'Cite in chat');
  expect(file.text).toBe(text);
});
