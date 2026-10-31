import {
  APP_RUNTIME_CODEMIRROR_MODULE,
  APP_RUNTIME_FILES_MODULE,
  APP_RUNTIME_MARKDOWN_MODULE,
  APP_RUNTIME_PREFIX,
  APP_RUNTIME_UI_CSS,
  APP_RUNTIME_UI_JS,
  noPageDialog,
  PAGE_DIALOGS,
} from '@shared/extensions/app-runtime-protocol';
import { createGugu } from './create-gugu';
import { framedHost } from './framed-host';
import { backgroundHost } from './background-host';
import type { GuguHost } from './host';

/**
 * `/_gugu/<ver>/gugu.js` — the first script of every App page (the host puts it there,
 * `injectAppRuntime`). It builds `window.gugu`.
 *
 * Why the runtime and not the preload builds it: an open file is a live Y.Doc and a live
 * editor binding, and both have to sit in the App's own JS world. Whatever crosses
 * contextBridge is copied, so the preload can only hand over the host bridge
 * (`__guguHost`); everything with state is built here, beside the App.
 *
 * Small on purpose. The open-file runtime (Yjs, the provider), the editor and the markdown rendering load on first use.
 */

type FilesModule = typeof import('./files-entry');
type CodemirrorModule = typeof import('./codemirror-entry');
type MarkdownModule = typeof import('./markdown-entry');

declare global {
  interface Window {
    __guguHost?: GuguHost;
  }
}

function install(): void {
  withoutPageDialogs();
  // The desktop preload's bridge; in an iframe of the outer gugu page (the phone), postMessage.
  const raw = window.__guguHost ?? (window.__guguBackgroundPost ? backgroundHost() : window.parent !== window ? framedHost() : undefined);
  // A page with no host is not an App surface. Loud: a gugu that half-exists is worse.
  if (!raw) throw new Error('gugu: this page has no host bridge');
  // The theme before the look (ui.css picks its palette by it): the first paint is in it, not in the OS's. ui.js follows
  // the context from here on.
  if (raw.theme) document.documentElement.dataset.guguTheme = raw.theme;
  let filesModule: Promise<FilesModule> | null = null;
  const gugu = createGugu(raw as GuguHost & Record<string, unknown>, {
    files: () => (filesModule ??= import(/* @vite-ignore */ runtimeUrl(APP_RUNTIME_FILES_MODULE)) as Promise<FilesModule>),
    codemirror: () => import(/* @vite-ignore */ runtimeUrl(APP_RUNTIME_CODEMIRROR_MODULE)) as Promise<CodemirrorModule>,
    markdown: () => import(/* @vite-ignore */ runtimeUrl(APP_RUNTIME_MARKDOWN_MODULE)) as Promise<MarkdownModule>,
  });
  Object.defineProperty(window, 'gugu', { value: gugu, enumerable: true, configurable: false, writable: false });
  reportUncaught(gugu.reportError as (message: string) => Promise<unknown>);
  // After a page/Markdown handler: a link it already took must not open a second time.
  window.addEventListener('click', (event) => {
    if (!event.isTrusted || event.defaultPrevented || typeof gugu.openLink !== 'function') return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor || !/^gugu(?:-[a-z0-9-]+)?:$/i.test(anchor.protocol) || anchor.protocol === location.protocol) return;
    event.preventDefault();
    void (gugu.openLink as (url: string) => Promise<unknown>)(anchor.href).catch((error: unknown) =>
      (gugu.reportError as (message: string) => Promise<unknown>)(error instanceof Error ? error.message : String(error)));
  });
  writeLook();
}

/**
 * Absolute, against the page's own address, and kept out of the bundler's sight (served by the host, not bundled):
 * on the phone this script is a no-cors classic script of an opaque-origin frame, whose base URL is about:blank —
 * a bare `/_gugu/…` would not resolve.
 */
function runtimeUrl(path: string): string {
  return new URL(path, location.href).href;
}

/**
 * The host's look (ui.css: every rule in `@layer gugu`, so anything the App writes wins) and its elements (ui.js), put
 * into the page right after this script: written into the parser's stream, so they come before the App's own
 * `<style>` / `<link>`, the App's first paint already has them (a stylesheet added by the DOM would not hold the first
 * paint back), and ui.js runs before the App's own scripts with `window.gugu` already there.
 */
function writeLook(): void {
  const css = runtimeUrl(APP_RUNTIME_UI_CSS);
  const js = runtimeUrl(APP_RUNTIME_UI_JS);
  if (document.readyState === 'loading') {
    document.write(`<link rel="stylesheet" href="${css}"><script src="${js}"></script>`);
    return;
  }
  // Not from the parser (the host always puts this script first; this is only a page that loaded it late): first in <head>.
  const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: css });
  const script = Object.assign(document.createElement('script'), { src: js });
  document.head.prepend(link, script);
}

/**
 * 摩擦单 F96: `alert` / `confirm` / `prompt` throw, saying what to do instead (`noPageDialog`, the sentence
 * `app_check` says too). Before, on the desktop `alert` / `confirm` put up a dialog that stops the page and
 * `prompt` threw Electron's own words; in the phone's frame they did nothing. Thrown, an App's call is its error like any other
 * (below): recorded, and its slot shows it. Set before any script of the App's own runs; an App that defines its own
 * `alert` (a toast of its own) is free to — what is gone is only the dialog that stops the page.
 */
function withoutPageDialogs(): void {
  for (const name of PAGE_DIALOGS) {
    window[name] = () => {
      throw new Error(noPageDialog(name));
    };
  }
}

/**
 * 摩擦单 F63: an App's own uncaught error, or a promise it let reject unhandled, is its error — recorded the way
 * `gugu.reportError` records one (the App's error record, which `app_check` reads back; the slot shows the App
 * has one). Each distinct one once. Silent, a broken 「提交」 looked fine to the person and to the agent that wrote it.
 */
/**
 * Where in the App's own code an error thrown in the runtime's file came from: the first frame of its stack outside the
 * runtime (`/_gugu/`). An error the runtime throws for the App's call (F96's `confirm()`, a refused `gugu.files` call)
 * says `gugu.js:1`; the line the author can act on is the one that called it. Null when the stack names no file of the App's.
 */
function appFrameOf(error: unknown): { file: string; line: number } | null {
  const stack = (error as { stack?: unknown } | null)?.stack;
  if (typeof stack !== 'string') return null;
  for (const match of stack.matchAll(/((?:gugu-ext|https?|file):\/\/[^\s()]+?):(\d+):\d+/g)) {
    if (!match[1]!.includes(APP_RUNTIME_PREFIX)) return { file: match[1]!, line: Number(match[2]) };
  }
  return null;
}

function reportUncaught(report: (message: string) => Promise<unknown>): void {
  const said = new Set<string>();
  const say = (message: string) => {
    if (said.has(message) || said.size >= 20) return;
    said.add(message);
    report(message.slice(0, 500)).catch(() => undefined);
  };
  const described = (thrown: unknown, fallback: string) => {
    const error = thrown as { name?: unknown; message?: unknown } | null;
    return error && typeof error === 'object' && typeof error.message === 'string' ? `${String(error.name ?? 'Error')}: ${error.message}` : fallback;
  };
  window.addEventListener('error', (event) => {
    const thrownAt = event.filename ? { file: event.filename, line: event.lineno } : null;
    // Thrown in the runtime's own file: the App's line that called it instead (below).
    const at = thrownAt?.file.includes(APP_RUNTIME_PREFIX) ? (appFrameOf(event.error) ?? thrownAt) : thrownAt;
    const where = at ? ` (${at.file.slice(at.file.lastIndexOf('/') + 1)}:${at.line})` : '';
    say(`Uncaught ${described(event.error, event.message)}${where}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    say(`Unhandled rejection: ${described(event.reason, String(event.reason))}`);
  });
  // A script or style sheet that cannot load — app.js importing a ./glue.js the bundle lacks: a blank page, and app_check
  // said ok (App作用域 10-05) — fires a plain `error` on its element that does not bubble: heard on its way down, or not at all.
  window.addEventListener(
    'error',
    ({ target }) => {
      const script = target instanceof HTMLScriptElement;
      const url = script ? target.src : target instanceof HTMLLinkElement && target.rel === 'stylesheet' ? target.href : null;
      if (url === null) return;
      const name = url ? url.slice(url.lastIndexOf('/') + 1) : 'a module script of the page';
      say(`Could not load ${name}${script ? ' (or a module it imports): it did not run' : ''}. Is a file missing from the App?`);
    },
    true,
  );
}

install();
