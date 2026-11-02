import { parseGroupFileLink } from '@gugu/core/shared/ui/guguLink';
import type { ChatHighlighter, HighlightResult } from '@gugu/session-chat-ui/highlight';
import { documentToHtml } from '@gugu/session-chat-ui/markdown-html';
import type { MarkdownTrust } from '@gugu/session-shared/markdown/dialect';
import { APP_RUNTIME_MARKDOWN_CSS } from '@shared/extensions/app-runtime-protocol';
import { revealMarkdownAnchor } from '../../components/markdown/revealAnchor';
import { createMermaidRenderId, renderMermaidDiagram } from '@gugu/session-chat-ui/mermaid';
import { guguError } from './host';

/**
 * `/_gugu/<ver>/markdown.js` — the host's markdown rendering on an App page, behind `gugu.markdown()`.
 *
 * Not a second renderer: the dialect (grammar, sanitize schema, KaTeX), the `.gg-md` look, the code highlighter and the
 * mermaid renderer are the very modules the host's surfaces use, built into the runtime with this gugu; the HTML is the
 * transcript's (`documentToHtml`: image chips, table scroll boxes). An App ships no markdown library and no typography
 * of its own. An image naming a file (`gugu-file://<id>`, or a path beside the document) is read through this page's own
 * `gugu.files` — the host's resolver and the App's grants — and drawn in its chip (`paintImages`).
 *
 * One verb, `render`: the sanitized markup goes into the page here and nowhere else — no HTML string is handed out for
 * an App to put through `innerHTML` itself. Links follow one policy here too (`followLink`).
 */

type Density = 'compact' | 'comfortable';
type RenderOptions = { trust: MarkdownTrust; density: Density; frontmatter: boolean; sourceLines: boolean; file: unknown };
type FileChange = { kind: string; entries?: { id: string; version?: number | null }[]; gone?: string[] };
/** What a link, an image and a code block's copy button need of `gugu` (create-gugu.ts hands its own object). */
type LinkVerbs = {
  openLink(url: string): Promise<unknown>;
  reportError(message: string): Promise<unknown>;
  openBrowserTab(url: string): Promise<unknown>;
  /** A code block's copy button goes through the host's clipboard (the platform's one exit; a phone's sandboxed page has
   *  none of its own). A page without it draws no copy button. */
  clipboard?: { writeText(text: string): Promise<unknown> };
  files: {
    openWith?(file: unknown, options?: { at?: Record<string, string> }): Promise<unknown>;
    open(file: unknown): Promise<unknown>;
    readVersion(file: unknown, n: number): Promise<unknown>;
    onChanged(place: unknown, handler: (change: FileChange) => void): () => void;
  };
};

const TRUSTS: readonly MarkdownTrust[] = ['chat', 'document'];
const DENSITIES: readonly Density[] = ['compact', 'comfortable'];

function optionsOf(value: unknown): RenderOptions {
  const given = (value ?? {}) as Partial<Record<keyof RenderOptions, unknown>>;
  if (typeof given !== 'object') throw guguError('invalid', 'markdown.render(element, text, options): options is an object');
  const trust = given.trust ?? 'chat';
  const density = given.density ?? 'compact';
  if (!TRUSTS.includes(trust as MarkdownTrust)) {
    throw guguError('invalid', `markdown.render: trust is 'chat' (others' words: raw HTML stays text) or 'document', not ${JSON.stringify(trust)}`);
  }
  if (!DENSITIES.includes(density as Density)) {
    throw guguError('invalid', `markdown.render: density is 'compact' or 'comfortable', not ${JSON.stringify(density)}`);
  }
  return { trust: trust as MarkdownTrust, density: density as Density, frontmatter: given.frontmatter === true, sourceLines: given.sourceLines === true, file: given.file };
}

// ── code: the transcript's highlighter, loaded with the first page that has code ──

let highlighter: Promise<{ hl: ChatHighlighter; paint: (code: HTMLElement, result: HighlightResult) => void }> | null = null;
const MAX_HIGHLIGHTED = 200;
const highlighted = new Map<string, HighlightResult>();

const MERMAID = 'pre > code.language-mermaid, pre > code.language-mmd';

function colourCode(root: HTMLElement): void {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')].filter((code) => !code.matches(MERMAID));
  if (blocks.length === 0) return;
  highlighter ??= import('@gugu/session-chat-ui/highlight').then((m) => ({ hl: m.createDefaultHighlighter(), paint: m.paintHighlight }));
  // Once loaded, this runs as a microtask, before the page paints: a re-render does not flash uncoloured code.
  void highlighter.then(({ hl, paint }) => {
    for (const code of blocks) {
      const lang = /language-(\S+)/.exec(code.className)?.[1];
      const text = code.textContent ?? '';
      const key = `${lang}\u0000${text}`;
      const done = () => {
        let result = highlighted.get(key) ?? null;
        if (!result) {
          result = hl.highlight(text, lang);
          if (!result) return false;
          if (highlighted.size >= MAX_HIGHLIGHTED) highlighted.delete(highlighted.keys().next().value!);
          highlighted.set(key, result);
        }
        if (code.isConnected) paint(code, result);
        return true;
      };
      if (!done()) void hl.load?.(lang)?.then(done);
    }
  });
}

// ── mermaid: the renderer the host's documents use (securityLevel strict), one diagram at a time ──

const MAX_DIAGRAMS = 50;
const diagrams = new Map<string, string>();

function drawDiagrams(root: HTMLElement): void {
  const theme = document.documentElement.dataset.guguTheme === 'dark' ? 'dark' : 'neutral';
  for (const code of root.querySelectorAll<HTMLElement>(MERMAID)) {
    const pre = code.parentElement!;
    const chart = code.textContent ?? '';
    const key = `${theme}\u0000${chart}`;
    const show = (svg: string) => {
      const box = document.createElement('div');
      box.className = 'gg-md-mermaid';
      if (pre.dataset.line) box.dataset.line = pre.dataset.line;
      box.innerHTML = svg;
      pre.replaceWith(box);
    };
    const hit = diagrams.get(key);
    if (hit !== undefined) {
      show(hit);
      continue;
    }
    // A chart mermaid cannot draw stays the code block it was.
    renderMermaidDiagram({ id: createMermaidRenderId(), chart, theme })
      .then((svg) => {
        if (diagrams.size >= MAX_DIAGRAMS) diagrams.delete(diagrams.keys().next().value!);
        diagrams.set(key, svg);
        if (pre.isConnected) show(svg);
      })
      .catch(() => undefined);
  }
}

// ── links: one policy for every App page, the host's ──

/**
 * A relative link in a file (`plan.md`, `./notes/a.md`, `../b.md`) names a file in the same place, beside it: from the
 * folder the file is in (its `path`; a chat file's `name` is its name alone). Above the top of the place is no file.
 */
function siblingOf(file: unknown, href: string): { chat: string; name: string } | { workspace: string; name: string } | null {
  const entry = ((file as { entry?: unknown } | null)?.entry ?? file) as { chat?: unknown; workspace?: unknown; name?: unknown; path?: unknown } | null;
  if (!entry || typeof entry !== 'object' || href.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  let path: string;
  try {
    path = decodeURIComponent(href.split(/[?#]/, 1)[0]!);
  } catch {
    return null;
  }
  const from = typeof entry.path === 'string' ? entry.path : typeof entry.name === 'string' ? entry.name : '';
  const parts: string[] = [];
  for (const part of `${from.slice(0, from.lastIndexOf('/') + 1)}${path}`.split('/')) {
    if (part === '..' && parts.pop() === undefined) return null;
    else if (part && part !== '.' && part !== '..') parts.push(part);
  }
  if (parts.length === 0) return null;
  const name = parts.join('/');
  if (typeof entry.chat === 'string') return { chat: entry.chat, name };
  if (typeof entry.workspace === 'string') return { workspace: entry.workspace, name };
  return null;
}

/**
 * `#…` scrolls to the heading or footnote in this document; `gugu-file://<id>` opens that chat file where the person is;
 * http(s) opens a browser tab; a relative link opens the file beside this one. Anything else does nothing: an App page
 * has no other way out (`openBrowserTab` takes only http(s)). The opens are the person's click, as their verbs need.
 */
function followLink(root: HTMLElement, gugu: LinkVerbs, file: unknown, href: string): void {
  if (href.startsWith('#')) {
    revealMarkdownAnchor(root, href.slice(1));
    return;
  }
  const failed = (error: unknown) => gugu.reportError(error instanceof Error ? error.message : String(error));
  if (/^https?:\/\//i.test(href)) {
    void gugu.openBrowserTab(href).catch(failed);
    return;
  }
  const sibling = siblingOf(file, href);
  if (sibling) void gugu.files.openWith?.(sibling)?.catch(failed);
  else void gugu.openLink(href).catch(failed);
}

// ── images: a file the document names, read through this page's `gugu.files` (its grants, the host's resolver) ──

/** An image's file: a group file's link (`?v=` that kept version), or a file beside the document. Anything else is none. */
function imageOf(file: unknown, src: string): { ref: object; version?: number } | null {
  const link = parseGroupFileLink(src);
  if (link) return { ref: { id: link.itemId }, ...(link.version === undefined ? {} : { version: link.version }) };
  const sibling = siblingOf(file, src);
  return sibling && { ref: sibling };
}

/** `url` once read; `failed` the host's reason; neither once settled: not a picture (a text file), the chip it was. */
type Picture = { settled: boolean; url?: string; failed?: string; chat?: string; id?: string; version?: number | null };
const MAX_PICTURES = 100;
/** Per file named: read once for the page however often its documents render, so a re-render paints it at once. */
const pictures = new Map<string, Picture>();
const watched = new Set<string>();

function forget(key: string): void {
  const url = pictures.get(key)?.url;
  if (url) URL.revokeObjectURL(url);
  pictures.delete(key);
}

async function readPicture(gugu: LinkVerbs, { ref, version }: { ref: object; version?: number }): Promise<Omit<Picture, 'settled'>> {
  if (version !== undefined) {
    const kept = await gugu.files.readVersion(ref, version);
    return kept instanceof Blob && kept.type.startsWith('image/') ? { url: URL.createObjectURL(kept) } : {};
  }
  const opened = (await gugu.files.open(ref)) as { type?: string; entry?: { id?: string; chat?: string; version?: number | null; contentType?: string }; blob?(): Promise<Blob>; close?(): void };
  if (opened.type !== 'binary' || !opened.entry?.contentType?.startsWith('image/') || !opened.blob) {
    opened.close?.();
    return {};
  }
  const { id, chat, version: current } = opened.entry;
  return { url: URL.createObjectURL(await opened.blob()), id, chat, version: current };
}

/** A new version of a picture's file, or the file gone: read it again where it is shown (`files.onChanged`, its chat). */
function watchChat(gugu: LinkVerbs, chat: string): void {
  if (watched.has(chat)) return;
  watched.add(chat);
  gugu.files.onChanged({ chat }, (change) => {
    const now = new Map((change.entries ?? []).map((entry) => [entry.id, entry.version]));
    const stale = [...pictures].filter(([, p]) => p.chat === chat && p.id && (change.gone?.includes(p.id) || (now.has(p.id) && now.get(p.id) !== p.version)));
    for (const [key] of stale) forget(key);
    if (stale.length > 0) repaint();
  });
}

const entryOf = (file: unknown) => (((file as { entry?: unknown } | null)?.entry ?? file) as { id?: unknown } | null)?.id;

function fill(slot: HTMLElement, picture: Picture | undefined): void {
  if (!picture?.settled) slot.dataset.ggImage = 'loading';
  else if (picture.url) {
    slot.dataset.ggImage = 'shown';
    slot.replaceChildren(Object.assign(document.createElement('img'), { className: 'gg-md-img', src: picture.url, alt: slot.textContent ?? '' }));
  } else if (picture.failed) {
    slot.dataset.ggImage = 'failed';
    slot.append(` — ${picture.failed}`);
  } else slot.removeAttribute('data-gg-image');
}

/** Each chip naming a file gets its picture, or says why not; one read per file, then every chip of it is painted. */
function paintImages({ root, gugu, options }: Rendered): void {
  for (const slot of root.querySelectorAll<HTMLElement>('a[data-gg-image=""], a[data-gg-image="loading"]')) {
    const image = imageOf(options.file, slot.getAttribute('href') ?? '');
    if (!image) {
      slot.removeAttribute('data-gg-image');
      continue;
    }
    const key = JSON.stringify(image);
    if (!pictures.has(key)) {
      if (pictures.size >= MAX_PICTURES) forget(pictures.keys().next().value!);
      const picture: Picture = { settled: false };
      pictures.set(key, picture);
      void readPicture(gugu, image)
        .catch((error: unknown): Omit<Picture, 'settled'> => ({ failed: error instanceof Error ? error.message : String(error) }))
        .then((read) => {
          if (pictures.get(key) !== picture) {
            if (read.url) URL.revokeObjectURL(read.url);
            return;
          }
          Object.assign(picture, read, { settled: true });
          if (picture.chat) watchChat(gugu, picture.chat);
          for (const root of document.querySelectorAll(`[${ROOT_MARK}]`)) {
            const entry = byRoot.get(root);
            if (entry) paintImages(entry);
          }
        });
    }
    fill(slot, pictures.get(key));
  }
}

// ── render ──

type Rendered = { target: Element; root: HTMLElement; text: string; options: RenderOptions; gugu: LinkVerbs };
/** Per element rendered into, and back from its root: weak, so a page that renders into many elements keeps none alive. */
const byTarget = new WeakMap<Element, Rendered>();
const byRoot = new WeakMap<Element, Rendered>();
const ROOT_MARK = 'data-gugu-markdown';

function paint(entry: Rendered): void {
  const { target, root, text, options } = entry;
  root.className = `gg-md gg-md--${options.density}`;
  // Images stay nodes, painted as link chips (the HTML loads nothing; `paintImages` fills those naming a file); the
  // transcript's HTML, sanitized once.
  // `sourceLines`: each block says the text's lines it came from (`data-line="3-5"`): a page finds a line's block by it.
  root.innerHTML = documentToHtml(text, { trust: options.trust, frontmatter: options.frontmatter, keepImageNodes: true, sourceLines: options.sourceLines });
  const copyLabel = /^zh\b/i.test(document.documentElement.lang) ? '复制' : 'Copy';
  for (const button of root.querySelectorAll('[data-gg-copy]')) {
    if (!entry.gugu.clipboard) {
      button.remove();
      continue;
    }
    button.setAttribute('aria-label', copyLabel);
    button.setAttribute('title', copyLabel);
  }
  // Only when it is not there yet: taking the root out and back would drop the scroll position of a scrolling target.
  if (root.parentNode !== target || target.childNodes.length !== 1) target.replaceChildren(root);
  colourCode(root);
  drawDiagrams(root);
  paintImages(entry);
}

/** Every document on the page, drawn again. */
function repaint(): void {
  for (const root of document.querySelectorAll(`[${ROOT_MARK}]`)) {
    const entry = byRoot.get(root);
    if (entry) paint(entry);
  }
}

let themeWatch: MutationObserver | null = null;
/** A diagram is drawn for the page's theme: when the person switches it, the documents on the page are drawn again. */
function watchTheme(): void {
  if (themeWatch) return;
  themeWatch = new MutationObserver(repaint);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-gugu-theme'] });
}

/** `render(element, text, options)`: exported for the runtime's own tests; a page reaches it only through `gugu.markdown()`. */
export function renderer(gugu: LinkVerbs) {
  return function render(target: unknown, text: unknown, options?: unknown): void {
    if (!(target instanceof Element)) throw guguError('invalid', 'markdown.render(element, text, options): render into an element of the page');
    if (typeof text !== 'string') throw guguError('invalid', 'markdown.render(element, text, options): text is the markdown, a string');
    const given = optionsOf(options);
    let entry = byTarget.get(target);
    if (!entry) {
      const root = document.createElement('div');
      root.setAttribute(ROOT_MARK, '');
      const made: Rendered = { target, root, text, options: given, gugu };
      root.addEventListener('click', (event) => {
        const copy = (event.target as Element | null)?.closest?.('[data-gg-copy]');
        const clipboard = gugu.clipboard;
        if (copy && clipboard && root.contains(copy)) {
          const code = copy.closest('.gg-md-code')?.querySelector('pre')?.textContent ?? '';
          void clipboard.writeText(code).then(
            () => {
              copy.setAttribute('data-copied', '');
              setTimeout(() => copy.removeAttribute('data-copied'), 1500);
            },
            (error: unknown) => gugu.reportError(error instanceof Error ? error.message : String(error))
          );
          return;
        }
        const link = (event.target as Element | null)?.closest?.('a[href]');
        if (!link || !root.contains(link)) return;
        event.preventDefault();
        followLink(root, gugu, made.options.file, link.getAttribute('href') ?? '');
      });
      byTarget.set(target, made);
      byRoot.set(root, made);
      entry = made;
    }
    // Another document here: a picture that could not be read is tried again (its holder may be back), not every keystroke.
    if (entryOf(given.file) !== entryOf(entry.options.file)) for (const [key, picture] of pictures) if (picture.failed) forget(key);
    entry.text = text;
    entry.options = given;
    paint(entry);
    watchTheme();
  };
}

let sheet: Promise<void> | null = null;
/** `.gg-md` and KaTeX, in `@layer gugu` like ui.css: linked once, before the first render, so nothing paints unstyled. */
function linkSheet(): Promise<void> {
  sheet ??= new Promise<void>((resolve, reject) => {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL(APP_RUNTIME_MARKDOWN_CSS, import.meta.url).href });
    link.onload = () => resolve();
    link.onerror = () => {
      sheet = null;
      link.remove();
      reject(guguError('failed', 'gugu.markdown(): its stylesheet could not be loaded'));
    };
    document.head.append(link);
  });
  return sheet;
}

/** What `gugu.markdown()` resolves to. */
export function markdownFor(gugu: LinkVerbs): Promise<Readonly<{ render: ReturnType<typeof renderer> }>> {
  return linkSheet().then(() => Object.freeze({ render: renderer(gugu) }));
}
