/**
 * Highlighter — ChatHighlighter interface + default factory.
 *
 * chat-ui defines the `ChatHighlighter` contract; consumers (the desktop session page)
 * can inject their own implementation through ChatRootProps / MountChatOptions.
 * When no highlighter is provided, `createDefaultHighlighter()` is used, which
 * wraps a bundled Shiki singleton with the chat-ui owned em-light/em-dark themes.
 *
 * IMPORTANT — dual-theme contract: any ChatHighlighter implementation MUST call
 * Shiki (or equivalent) with `themes: { light, dark }, defaultColor: false` so
 * the token htmlStyle properties carry `--shiki-light` / `--shiki-dark` vars and
 * rootStyle carries `--shiki-light-bg` / `--shiki-dark-bg`. Code.tsx and
 * diff.module.css consume these exact var names via `.emdark:` variant classes.
 */

import bash from '@shikijs/langs/bash';
import javascript from '@shikijs/langs/javascript';
import json from '@shikijs/langs/json';
import python from '@shikijs/langs/python';
import typescript from '@shikijs/langs/typescript';
import type { LanguageRegistration, ThemeRegistrationRaw } from 'shiki/core';
import { createHighlighterCoreSync } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { BUNDLED_DARK_THEME, BUNDLED_LIGHT_THEME } from './bundled-themes';
import type { LazyLangId } from './lazy-langs';

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single token within a highlighted line. */
export type CodeToken = {
  content: string;
  /** CSS custom-property declarations, e.g. { '--shiki-light': '#..', '--shiki-dark': '#..' } */
  htmlStyle?: Record<string, string>;
};

/** Result of highlighting a code block. */
export type HighlightResult = {
  /**
   * Inline style string to set on the block wrapper to supply the background
   * CSS vars: `--shiki-light-bg` and `--shiki-dark-bg`.
   */
  rootStyle: string;
  /** Per-line token arrays. Length matches the number of `\n`-split lines. */
  lines: CodeToken[][];
};

/**
 * Syntax highlighter adapter contract owned by chat-ui.
 *
 * Implementations MUST emit the dual-theme CSS-var contract consumed by
 * Code.tsx and diff.module.css:
 *   token htmlStyle → --shiki-light / --shiki-dark
 *   rootStyle       → --shiki-light-bg / --shiki-dark-bg
 *
 * Return null for unsupported / unrecognised languages (the cache handles it
 * gracefully — the code renders un-highlighted).
 */
export interface ChatHighlighter {
  highlight(code: string, lang: string | undefined): HighlightResult | null;
  /**
   * Optional: make `lang` highlightable. Returns a promise when the language is
   * supported but its grammar is still loading — once it resolves, `highlight()`
   * for that language stops returning null. Returns null when there is nothing
   * to wait for (already loaded, or not a supported language).
   */
  load?(lang: string | undefined): Promise<void> | null;
}

// ── Language registry ─────────────────────────────────────────────────────────

/** Grammars bundled into the main chunk: highlightable synchronously from the start. */
const EAGER_LANGS = { typescript, javascript, python, json, bash };

type LangLoader = () => Promise<{ default: LanguageRegistration[] }>;

/**
 * Grammars fetched on first use, each as its own chunk, so they cost nothing
 * until a transcript actually contains that language. Same set as the
 * session renderer's markdown highlighter. The import specifiers must stay
 * literal for the bundler; `satisfies` pins the keys to LAZY_LANG_IDS, which the
 * Vite configs pre-declare.
 */
const LAZY_LANG_LOADERS: Record<string, LangLoader> = {
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  diff: () => import('@shikijs/langs/diff'),
  docker: () => import('@shikijs/langs/docker'),
  go: () => import('@shikijs/langs/go'),
  html: () => import('@shikijs/langs/html'),
  java: () => import('@shikijs/langs/java'),
  jsx: () => import('@shikijs/langs/jsx'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  markdown: () => import('@shikijs/langs/markdown'),
  php: () => import('@shikijs/langs/php'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  sql: () => import('@shikijs/langs/sql'),
  swift: () => import('@shikijs/langs/swift'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
} satisfies Record<LazyLangId, LangLoader>;

const SUPPORTED_LANGS = new Set([...Object.keys(EAGER_LANGS), ...Object.keys(LAZY_LANG_LOADERS)]);

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  jsonc: 'json',
  json5: 'json',
  'c++': 'cpp',
  cs: 'csharp',
  dockerfile: 'docker',
  golang: 'go',
  htm: 'html',
  kt: 'kotlin',
  kts: 'kotlin',
  md: 'markdown',
  patch: 'diff',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
};

export function resolveAlias(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const lower = lang.toLowerCase();
  return LANG_ALIASES[lower] ?? (SUPPORTED_LANGS.has(lower) ? lower : undefined);
}

// ── Default highlighter implementation ────────────────────────────────────────

type SyncHighlighter = ReturnType<typeof createHighlighterCoreSync>;
let _defaultHighlighter: SyncHighlighter | null = null;

/** Resolved language ids whose grammar is registered on the singleton. */
const readyLangs = new Set<string>(Object.keys(EAGER_LANGS));
/** In-flight grammar loads, so concurrent blocks share one import. */
const loadingLangs = new Map<string, Promise<void>>();

function getDefaultShikiHighlighter(): SyncHighlighter {
  if (!_defaultHighlighter) {
    _defaultHighlighter = createHighlighterCoreSync({
      engine: createJavaScriptRegexEngine(),
      langs: Object.values(EAGER_LANGS),
      themes: [
        BUNDLED_LIGHT_THEME as unknown as ThemeRegistrationRaw,
        BUNDLED_DARK_THEME as unknown as ThemeRegistrationRaw,
      ],
    });
  }
  return _defaultHighlighter;
}

function loadLanguage(resolvedLang: string): Promise<void> | null {
  if (readyLangs.has(resolvedLang)) return null;
  const loader = LAZY_LANG_LOADERS[resolvedLang];
  if (!loader) return null;
  let pending = loadingLangs.get(resolvedLang);
  if (!pending) {
    pending = loader().then(
      (mod) => {
        getDefaultShikiHighlighter().loadLanguageSync(mod.default);
        readyLangs.add(resolvedLang);
        loadingLangs.delete(resolvedLang);
      },
      (error: unknown) => {
        // Forget the failed import so a later block can try again.
        loadingLangs.delete(resolvedLang);
        throw error;
      }
    );
    loadingLangs.set(resolvedLang, pending);
  }
  return pending;
}

/**
 * Tokenise `code` using the bundled Shiki singleton for the given resolved language.
 * Pure — no internal cache. Caching is handled by ChatCaches in core/caches.ts.
 */
export function computeHighlightRaw(code: string, resolvedLang: string): HighlightResult {
  const hl = getDefaultShikiHighlighter();
  const result = hl.codeToTokens(code, {
    lang: resolvedLang,
    themes: { light: 'em-light', dark: 'em-dark' },
    defaultColor: false,
  });

  const lines: CodeToken[][] = result.tokens.map((line) =>
    line.map((tok) => {
      const token: CodeToken = { content: tok.content };
      if (tok.htmlStyle && Object.keys(tok.htmlStyle).length > 0) {
        token.htmlStyle = tok.htmlStyle as Record<string, string>;
      }
      return token;
    })
  );

  const rootStyle = typeof result.bg === 'string' ? result.bg : '';
  return { rootStyle, lines };
}

/**
 * Create the default ChatHighlighter backed by the bundled em-light/em-dark
 * Shiki themes. Used automatically when no highlighter is injected through
 * ChatRootProps.
 *
 * ts/js/python/json/bash are highlightable immediately; the other common
 * languages in LAZY_LANG_LOADERS return null from `highlight()` until `load()`
 * has fetched their grammar.
 */
export function createDefaultHighlighter(): ChatHighlighter {
  return {
    highlight(code: string, lang: string | undefined): HighlightResult | null {
      const resolved = resolveAlias(lang);
      if (!resolved || !readyLangs.has(resolved)) return null;
      return computeHighlightRaw(code, resolved);
    },
    load(lang: string | undefined): Promise<void> | null {
      const resolved = resolveAlias(lang);
      if (!resolved) return null;
      return loadLanguage(resolved);
    },
  };
}

/**
 * Colour a `<code>` element that already holds `result`'s text: one span per token, carrying the dual-theme vars
 * (`markdown.css` reads `--shiki-light` / `--shiki-dark`), lines joined by `\n`. Shared by the transcript's html runs and
 * App pages (`gugu.markdown()`), so code is coloured one way wherever sanitized markdown HTML is painted.
 */
export function paintHighlight(code: HTMLElement, result: HighlightResult): void {
  code.replaceChildren(
    ...result.lines.flatMap((line, index) => {
      const tokens = line.map((token) => {
        const span = document.createElement('span');
        span.textContent = token.content;
        for (const [prop, value] of Object.entries(token.htmlStyle ?? {})) span.style.setProperty(prop, value);
        return span;
      });
      return index > 0 ? [document.createTextNode('\n'), ...tokens] : tokens;
    })
  );
}
