import type { ExtensionHostContext } from '@shared/extensions/bridge-protocol';
import { ICONS, ICON_SVG_ATTRIBUTES, timePhrase } from './ui-core';

/**
 * `/_gugu/<ver>/ui.js` — the host's components for App pages, loaded right after gugu.js (which writes its tag), with
 * ui.css. Only what plain HTML cannot do, or what needs the host's data:
 *
 *   <gugu-icon name="bell">                  gugu's own Solar icons, named as lucide names them (bell, users, trash-2…)
 *   <gugu-avatar user="user:…" name>         a member's face (with `name`: and their name); an agent's carries ⚡
 *   <gugu-time datetime="2026-10-05T08:30">  「刚刚 / 3 分钟前 / 08:20 / 昨天 14:20 / 10月3日」, kept current
 *   <gugu-empty icon="archive">…</gugu-empty> an empty state around the App's own words and button
 *
 * And the theme: `<html data-gugu-theme>` follows `context.themeMode`, which picks the palette in ui.css (gugu.js has set
 * it already, before the first paint, where the host knows it then: `GuguHost.theme`).
 *
 * Insides are drawn in shadow DOM: an App's `render()` (the template's patching redraw) sees only the empty element
 * and never strips the icon or the face as a child it did not write. ui.css sizes and places the elements (the App can
 * change that); `::part(svg | face | img | badge | name | icon)` reach inside.
 */

type Context = Partial<Pick<ExtensionHostContext, 'locale' | 'themeMode' | 'chat'>>;
interface PageGugu {
  getContext?: () => Promise<Context>;
  onContextChanged?: (handler: (context: Context) => void) => unknown;
  reportError?: (message: string, options?: { level?: 'error' | 'hint' }) => Promise<void>;
}

const host = (): PageGugu | undefined => (window as unknown as { gugu?: PageGugu }).gugu;

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sheet = (css: string) => {
  const s = new CSSStyleSheet();
  s.replaceSync(css);
  return s;
};
const svgOf = (name: string) => {
  const body = ICONS.get(name);
  const attributes = Object.entries(ICON_SVG_ATTRIBUTES.get(name) ?? {}).map(([key, value]) => {
    const attribute = key === 'className' ? 'class' : key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    return ` ${attribute}="${esc(value)}"`;
  }).join('');
  return body ? `<svg part="svg" viewBox="0 0 24 24" aria-hidden="true"${attributes}>${body}</svg>` : '';
};

// ── The context: one read shared by every element, replaced when the host pushes a new one ───────────────────────────
let current: Promise<Context> | null = null;
function context(): Promise<Context> {
  current ??= Promise.resolve()
    .then(() => host()?.getContext?.())
    .catch(() => undefined)
    .then((value) => value ?? {});
  return current;
}
function setTheme(themeMode: Context['themeMode']): void {
  if ((themeMode === 'light' || themeMode === 'dark') && document.documentElement.dataset.guguTheme !== themeMode) {
    document.documentElement.dataset.guguTheme = themeMode;
  }
}

// ── <gugu-icon> ─────────────────────────────────────────────────────────────────────────────────────────────────────
const iconSheet = sheet(':host{display:inline-block}svg{display:block;width:100%;height:100%}');
const warned = new Set<string>();
export class GuguIcon extends HTMLElement {
  static observedAttributes = ['name', 'label'];
  static get names(): string[] {
    return [...ICONS.keys()];
  }
  connectedCallback(): void {
    this.draw();
  }
  attributeChangedCallback(): void {
    if (this.isConnected) this.draw();
  }
  private draw(): void {
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [iconSheet];
    const name = this.getAttribute('name') ?? '';
    if (!ICONS.has(name) && !warned.has(name)) {
      warned.add(name);
      const near = [...ICONS.keys()].filter((known) => name && (known.includes(name) || name.includes(known))).slice(0, 6);
      // A hint for the App's author (app_check reads it back), never a failure of the page.
      void host()?.reportError?.(
        `gugu: <gugu-icon name="${name}">: no such icon.${near.length ? ` Close: ${near.join(', ')}.` : ''} All names: customElements.get('gugu-icon').names`,
        { level: 'hint' },
      );
    }
    root.innerHTML = svgOf(name);
    const label = this.getAttribute('label');
    if (label) {
      this.setAttribute('role', 'img');
      this.setAttribute('aria-label', label);
    } else {
      this.setAttribute('aria-hidden', 'true');
    }
  }
}

// ── <gugu-avatar> ───────────────────────────────────────────────────────────────────────────────────────────────────
const SIZES = new Set(['xs', 'sm', 'md', 'lg']);
const avatarSheet = sheet(`
:host { display: inline-flex; align-items: center; min-width: 0; }
.face { position: relative; flex: none; display: grid; place-items: center; border-radius: 50%; background: var(--em-background-3); color: var(--em-foreground-passive); }
.face img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; }
.face > svg { width: 62%; height: 62%; }
.xs { width: var(--em-avatar-xs); height: var(--em-avatar-xs); }
.sm { width: var(--em-avatar-sm); height: var(--em-avatar-sm); }
.md { width: var(--em-avatar-md); height: var(--em-avatar-md); }
.lg { width: var(--em-avatar-lg); height: var(--em-avatar-lg); }
.badge { position: absolute; right: -2px; bottom: -2px; width: 30%; height: 30%; min-width: 12px; min-height: 12px; display: grid; place-items: center;
  border-radius: 50%; background: var(--em-background); color: var(--em-foreground); }
.badge svg { width: 78%; height: 78%; }
.xs .badge { display: none; }
.name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bolt { flex: none; width: 12px; height: 12px; margin-inline-start: -4px; color: currentColor; }
.bolt svg { display: block; width: 100%; height: 100%; }
`);
const avatars = new Set<GuguAvatar>();
export class GuguAvatar extends HTMLElement {
  static observedAttributes = ['user', 'size', 'name', 'label'];
  private turn = 0;
  connectedCallback(): void {
    avatars.add(this);
    void this.draw();
  }
  disconnectedCallback(): void {
    avatars.delete(this);
  }
  attributeChangedCallback(): void {
    if (this.isConnected) void this.draw();
  }
  async draw(): Promise<void> {
    const turn = ++this.turn;
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [avatarSheet];
    const members = (await context()).chat?.members;
    if (turn !== this.turn) return;
    // Only the chat's members come with the context (with their face: the uploaded one, or the default face from the
    // stable id). Anyone else is not drawn as a person the page knows: a neutral figure, named by `label`.
    const member = members?.find((m) => m.id === this.getAttribute('user'));
    const name = member?.name ?? this.getAttribute('label') ?? '';
    const size = SIZES.has(this.getAttribute('size') ?? '') ? this.getAttribute('size')! : 'sm';
    const agent = member?.kind === 'agent';
    const face = member?.avatar ? `<img part="img" src="${esc(member.avatar)}" alt="">` : svgOf('user');
    const showName = this.hasAttribute('name');
    root.innerHTML =
      `<span part="face" class="face ${size}">${face}${agent ? `<span class="badge" part="badge">${svgOf('zap')}</span>` : ''}</span>` +
      (showName ? `<span part="name" class="name">${esc(name)}</span>${agent ? `<span class="bolt">${svgOf('zap')}</span>` : ''}` : '');
    if (showName) {
      this.removeAttribute('role');
      this.removeAttribute('aria-label');
    } else {
      this.setAttribute('role', 'img');
      this.setAttribute('aria-label', agent ? `${name} (agent)` : name);
    }
  }
}

// ── <gugu-time> ─────────────────────────────────────────────────────────────────────────────────────────────────────
const times = new Set<GuguTime>();
let ticker: ReturnType<typeof setInterval> | null = null;
function when(value: string | null): Date | null {
  if (!value) return null;
  const date = /^\d+$/.test(value) ? new Date(Number(value)) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
export class GuguTime extends HTMLElement {
  static observedAttributes = ['datetime'];
  connectedCallback(): void {
    times.add(this);
    ticker ??= setInterval(() => {
      for (const time of times) void time.draw();
    }, 30_000);
    void this.draw();
  }
  disconnectedCallback(): void {
    times.delete(this);
    if (times.size === 0 && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }
  attributeChangedCallback(): void {
    if (this.isConnected) void this.draw();
  }
  async draw(): Promise<void> {
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    const { locale } = await context();
    const zh = String(locale ?? navigator.language).toLowerCase().startsWith('zh');
    const date = when(this.getAttribute('datetime'));
    root.innerHTML = date
      ? `<time datetime="${esc(date.toISOString())}" title="${esc(date.toLocaleString(zh ? 'zh-CN' : 'en-US', { hour12: false }))}">${esc(timePhrase(date, new Date(), zh))}</time>`
      : '';
  }
}

// ── <gugu-empty> ────────────────────────────────────────────────────────────────────────────────────────────────────
const emptySheet = sheet(`
:host { display: flex; }
.icon { display: block; width: var(--em-icon-lg); height: var(--em-icon-lg); margin-bottom: var(--em-spacing-xs); color: var(--em-foreground-passive); }
.icon svg { display: block; width: 100%; height: 100%; }
::slotted(strong) { color: var(--em-foreground); font-weight: 500; }
::slotted(small) { color: var(--em-foreground-muted); }
`);
export class GuguEmpty extends HTMLElement {
  static observedAttributes = ['icon'];
  connectedCallback(): void {
    this.draw();
  }
  attributeChangedCallback(): void {
    if (this.isConnected) this.draw();
  }
  private draw(): void {
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [emptySheet];
    const icon = this.getAttribute('icon');
    root.innerHTML = `${icon && ICONS.has(icon) ? `<span class="icon" part="icon">${svgOf(icon)}</span>` : ''}<slot></slot>`;
  }
}

function install(): void {
  if (customElements.get('gugu-icon')) return;
  customElements.define('gugu-icon', GuguIcon);
  customElements.define('gugu-avatar', GuguAvatar);
  customElements.define('gugu-time', GuguTime);
  customElements.define('gugu-empty', GuguEmpty);
  void context().then((value) => setTheme(value.themeMode));
  // The host pushes a new context when the theme, the language or the members change: everything follows.
  host()?.onContextChanged?.((next) => {
    current = Promise.resolve(next ?? {});
    setTheme(next?.themeMode);
    for (const avatar of avatars) void avatar.draw();
    for (const time of times) void time.draw();
  });
}

install();
