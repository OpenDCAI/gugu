import type { ExtensionHostContext } from '@shared/extensions/bridge-protocol';

/**
 * `/_gugu/<ver>/glue.js` — the fixed half of a page that opens one file (F55, S1: the first request wrote ~4.4k tokens,
 * app.js ~1k of it): it opens the file the page was opened on (a chat's, or a session's), and says in the status line when
 * it cannot, and when it is offline or gone. app.js imports f, me, myName, $, $$, html and render from here.
 *
 * Served by the host, as gugu.js is, not copied into each App: the copies did not follow the host (#6914's taskId → chatId
 * left seven Apps reading taskId), and an App whose bundle lacked its copy was a blank page (App作用域 10-05). An App that
 * wants it otherwise writes its own module; this one is only where the template starts.
 */

/** What this module uses of `gugu`, which gugu.js has put on the page before any module runs. */
interface OpenedFile {
  onStatus(handler: (status: string) => void): unknown;
  presence: { self: { userId: string; name: string } };
}
declare const gugu: {
  getContext(): Promise<ExtensionHostContext>;
  files: { open(file: NonNullable<ExtensionHostContext['file']>): Promise<OpenedFile> };
};

const { locale, chat, file } = await gugu.getContext();
// Where the file is (`ctx.file` says it): a chat's (a group, a topic or a private chat), or a folder on the computer.
// Opened for none: where the page is says where its files would be.
const inChat = file ? 'chat' in file || !('session' in file || 'project' in file) : Boolean(chat);
const zh = locale.toLowerCase().startsWith('zh');
// Said where the page is: a session's file is a file on the disk, a chat's is one of the chat's files.
const say = {
  pick(claims: string[]) {
    if (!claims.length) return zh ? '这个页面没有打开文件。' : 'No file is open here.';
    const names = claims.map((c) => (c.startsWith('.') ? (zh ? `一个 ${c} 文件` : `a ${c} file`) : c)).join(zh ? ' 或' : ' or ');
    const place = inChat ? (zh ? '这个对话的文件夹' : "the chat's folder") : zh ? '文件列表' : 'the file list';
    return zh ? `这个页面没有打开文件：在${place}里点 ${names}，用这个 App 打开。` : `No file is open here: click ${names} in ${place} to open it with this App.`;
  },
  failed: zh ? '打不开这个文件：' : 'Could not open the file: ',
  offline: zh ? '离线：你的改动会在回线后补上。' : 'Offline — your changes are sent when you are back.',
  gone: !inChat
    ? zh
      ? '这个文件在磁盘上被删了。把它恢复（比如 git checkout），这里会自己回来。'
      : 'This file was deleted on disk. Put it back (git checkout, an undo) and it comes back here.'
    : zh
      ? '这个文件不在了：被删了，或者你已不在这个对话里。'
      : 'This file is gone: it was deleted, or you left its chat.',
};

// $('#board') and $$('.card') are document.querySelector / querySelectorAll, as everywhere else (F75: an agent wrote
// $('#board') against a getElementById and got null six installs in a row).
export const $ = (selector: string) => document.querySelector(selector);
export const $$ = (selector: string) => [...document.querySelectorAll(selector)];

// html`<li>${name}</li>` is markup in which every ${…} goes in as text: what anyone in the chat typed never becomes
// HTML (F64: a title joined into innerHTML could draw a fake button). An html`…` inside, or an array of them, goes in
// as markup. Put it in with render(el, html`…`). Joined or added to a string it throws (F113: the S23 board joined its
// rows, and every card showed as its source).
class Markup {
  readonly markup: string;
  constructor(markup: string) {
    this.markup = markup;
  }
  toString(): string {
    throw new Error('html`…` is not a string: put it in as it is, an array of them too — render(el, html`<ul>${rows}</ul>`) — never joined.');
  }
}
const text = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export function html(strings: TemplateStringsArray, ...values: unknown[]): Markup {
  const part = (value: unknown): string => (value instanceof Markup ? value.markup : Array.isArray(value) ? value.map(part).join('') : text(value));
  return new Markup(strings.reduce((out, piece, i) => out + part(values[i - 1]) + piece));
}

// render(el, html`…`) redraws el as a patch, not a rebuild (F104): elements are matched by data-key (or id), else by
// place and tag, and kept; the control someone is in (focused, typing, mid-IME) keeps its value and focus — B's
// half-typed "12" stays B's while A's edit redraws the table, and goes in when B is done. Anything else is updated.
export function render(el: Element, markup: unknown): void {
  const next = document.createElement('template');
  next.innerHTML = markup instanceof Markup ? markup.markup : text(markup);
  patchChildren(el, next.content);
}
const isElement = (node: Node): node is Element => node.nodeType === 1;
const keyOf = (node: Node) => (isElement(node) ? (node.getAttribute('data-key') ?? (node.id || null)) : null);
// What a node is matched by: its tag and key; keyless ones by tag, in order.
const matchOf = (node: Node) => {
  const key = keyOf(node);
  return key === null ? node.nodeName : `${node.nodeName} ${key}`;
};
// In use: someone is typing in it, or in a control inside it. A button, link or checkbox that only has focus because it
// was clicked is not: it is redrawn and taken out like the rest (抽卡台 0.3.0: a clicked step never lit up, and a
// clicked 「选这张」 stayed where the markup had 「批注」). A slider being dragged (range) is in use.
const typedIn = (el: Element) =>
  (el.tagName === 'INPUT' && !/^(button|submit|reset|image|checkbox|radio)$/.test((el as HTMLInputElement).type)) ||
  /^(TEXTAREA|SELECT)$/.test(el.tagName) ||
  (el as HTMLElement).isContentEditable;
const inUse = (node: Node) => {
  const active = document.activeElement;
  return active !== null && typedIn(active) && node.contains(active);
};
function patchChildren(parent: Node, source: Node): void {
  const old = [...parent.childNodes];
  // One pass over the old children, so a table of thousands of rows is not searched once per row (L4's review).
  const pool = new Map<string, { nodes: ChildNode[]; next: number }>();
  for (const node of old) {
    const match = matchOf(node);
    if (!pool.has(match)) pool.set(match, { nodes: [], next: 0 });
    pool.get(match)!.nodes.push(node);
  }
  const kept = new Set<Node>();
  const nodes = [...source.childNodes].map((want) => {
    const bucket = pool.get(matchOf(want));
    const found = bucket?.nodes[bucket.next++];
    if (found) patch(found, want);
    const node = found ?? want;
    kept.add(node);
    return node;
  });
  // Gone from the markup, but not the one in use: taking it out would blur it and hand its half-typed value on.
  for (const node of old) if (!kept.has(node) && !inUse(node)) node.remove();
  // Into order from the end, moving others around the one with the focus, whatever it is — moving it would blur it
  // (a keyboard vote that re-sorts the list would drop the voter back to the page top).
  let after: Node | null = null;
  for (const node of nodes.reverse()) {
    const placed = node.parentNode === parent;
    if ((!placed || node.nextSibling !== after) && !(placed && node.contains(document.activeElement))) parent.insertBefore(node, after);
    after = node;
  }
}
function patch(node: Node, want: Node): void {
  if (!isElement(node) || !isElement(want)) {
    if (node.nodeValue !== want.nodeValue) node.nodeValue = want.nodeValue;
    return;
  }
  if (node === document.activeElement && inUse(node)) return;
  for (const { name } of [...node.attributes]) if (!want.hasAttribute(name)) node.removeAttribute(name);
  for (const { name, value } of [...want.attributes]) if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  patchChildren(node, want);
  // What the data says, for a control nobody is in (a value typed earlier and left is the file's by now).
  if (node.tagName === 'INPUT') {
    const { value, checked } = want as HTMLInputElement;
    Object.assign(node, { value, checked });
  } else if (node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') (node as HTMLTextAreaElement).value = (want as HTMLTextAreaElement).value;
}

// The status line: main.html has one, and app.js may redraw the whole page — then it is made again, first in the body
// (F101: offline, gone and errors must still have somewhere to be said).
// The host's look draws it: role="status" a quiet note, role="alert" an error.
function status(message: string, tone = 'info'): void {
  let line = document.getElementById('status');
  if (!line) {
    line = Object.assign(document.createElement('div'), { id: 'status' });
    document.body.prepend(line);
  }
  line.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  // Never hidden: a live region taken out and put back is missed by some screen readers; empty, it takes no space.
  line.textContent = message;
}

// Opened with no file: which files this App opens where the page is — its manifest's opensFiles, the one place that
// is said, so renaming the claim there is the whole change (F95). The App's manifest.json: fetched against the page.
async function claimsHere(): Promise<string[]> {
  type Tab = { opensFiles?: { chat?: string[]; session?: string[] } };
  const { contributes } = (await (await fetch('manifest.json')).json()) as { contributes: { tabs: Tab[] } };
  return contributes.tabs.flatMap(({ opensFiles }) => opensFiles?.[inChat ? 'chat' : 'session'] ?? []);
}
async function open(): Promise<OpenedFile> {
  if (!file) {
    status(say.pick(await claimsHere().catch(() => [])), 'error');
    throw Object.assign(new Error('This page was not opened for a file'), { code: 'not-found' });
  }
  try {
    return await gugu.files.open(file); // the file the host handed this page: no capability needed
  } catch (error) {
    const { message } = error as { message?: string };
    status(say.failed + String(message), 'error');
    throw error;
  }
}
/** The file, live. */
export const f = await open();
// A change the file service refused (too large) is the runtime's to say, for every App alike (A6).
f.onStatus((s) => {
  // Gone: what is on screen is no longer the file — dimmed and out of reach (a drag would go nowhere) until it is back
  // (a session's file put back on the disk comes back by itself: online again, and onChange brings its content).
  // The body, which every page has — an App may redraw the rest of it (F101), #app included.
  document.body.inert = s === 'gone';
  document.body.dataset.file = s;
  if (s === 'offline') status(say.offline);
  else if (s === 'gone') status(say.gone, 'error');
  else status('');
});
/** Who "me" is, stamped by the server — always there, so never ask the person their name. */
export const me = f.presence.self.userId; // 'user:<uuid>', the id agents see in MCP
export const myName = f.presence.self.name;
