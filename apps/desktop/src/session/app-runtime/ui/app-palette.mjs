/**
 * The App palette: every `--em-*` name an App page gets, as the gugu token it stands for — resolved at build time from
 * `apps/desktop/src/styles/tokens.css` into the `@layer gugu` block of `/_gugu/<ver>/ui.css` (buildAppRuntime).
 *
 * One source for every surface. Before, the host read the `--em-*` values computed where the App's frame sat and sent
 * them in (`buildExtensionThemeCss`). On the desktop that was the session page's own values; a group App on the phone and
 * the web sat in GroupAppSlot's iframe, under `.emlight` / `.emdark` but not `.gugu-skin`, and got session-ui's raw
 * palette — a jade-green primary (real WebView 113, 10-05: `--em-accent-9` = `display-p3(0 .63 .46)`). Now the values
 * are this build's tokens, both themes, and the page picks one by `context.themeMode` (ui.js sets `<html data-gugu-theme>`).
 *
 * Names: gugu's own token name with `em-`, so a new one is never invented. Kept from before only the ones Apps use (10-05:
 * the 7 in this repo + the latest package of all 100 Apps sent in chats on the shared test DB, read for `--em-*`):
 * background, foreground, border, foreground-muted, foreground-destructive, accent-9, accent-contrast, surface,
 * background-3, accent-11 — plus background-muted, which the old app_create template used (31 of those 100) but no
 * palette ever defined.
 *
 * Plain JS with no imports, its types in app-palette.d.mts — like the other modules vite.config.mts loads: the main
 * build stage imports the config under tsx, where a .ts file of apps/desktop (no `"type": "module"`) is CommonJS and
 * its named exports are not seen by an ESM import.
 */

/** Theme-dependent: written once per theme (and per OS contrast / transparency setting). */
export const APP_PALETTE_COLORS = [
  ['--em-background', 'var(--bg)'],
  ['--em-surface', 'var(--bg)'],
  ['--em-surface-input', 'var(--input-bg)'],
  ['--em-background-1', 'var(--card)'],
  ['--em-background-3', 'var(--muted)'],
  ['--em-background-muted', 'var(--muted)'],
  ['--em-foreground', 'var(--fg)'],
  ['--em-accent-11', 'var(--fg)'],
  ['--em-foreground-muted', 'var(--muted-fg)'],
  ['--em-foreground-passive', 'var(--faint-fg)'],
  ['--em-border', 'var(--border)'],
  ['--em-border-1', 'var(--border-strong)'],
  // The primary is ink (design.md): near-white on dark, near-black on light — never a second accent.
  ['--em-accent-9', 'var(--primary)'],
  ['--em-accent-contrast', 'var(--primary-fg)'],
  // gugu has one red, one green, one amber and one blue (--live: links, selected, running).
  ['--em-foreground-destructive', 'var(--danger)'],
  // White text on the saturated red — the same --color-white the host's ui/Button danger uses (#7333). Not --primary-fg:
  // that is the inverted ink, the surface colour in dark (#181818), and would turn the red button's label dark grey.
  ['--em-color-white', 'var(--color-white)'],
  ['--em-background-destructive', 'var(--danger-tint)'],
  ['--em-foreground-success', 'var(--ok)'],
  ['--em-background-success', 'var(--ok-tint)'],
  ['--em-foreground-warning', 'var(--warn)'],
  ['--em-background-warning', 'var(--warn-tint)'],
  ['--em-foreground-info', 'var(--live)'],
  ['--em-background-info', 'var(--live-soft)'],
  // State overlays (translucent: right on any surface) and the shadows: lift for what floats, dialog for the dialog (#7333).
  ['--em-hover', 'var(--hover)'],
  ['--em-press', 'var(--press)'],
  ['--em-selected', 'var(--selected)'],
  // The keyboard focus ring (#7333: a ring for the keyboard, none for a click), the host's --focus-ring.
  ['--em-focus-ring', 'var(--focus-ring)'],
  ['--em-shadow-lift', 'var(--shadow-lift)'],
  ['--em-shadow-dialog', 'var(--shadow-dialog)'],
];

/** Theme-independent scales, in the order tokens.css gives them. */
export const APP_PALETTE_SCALES = [
  ['--em-font-sans', 'var(--font-family-system)'],
  ['--em-font-mono', 'var(--font-family-mono)'],
  ['--em-font-caption', 'var(--font-caption)'],
  ['--em-font-body', 'var(--font-body)'],
  ['--em-font-title', 'var(--font-title)'],
  ['--em-font-heading', 'var(--font-heading)'],
  ['--em-font-page', 'var(--font-size-xl)'],
  ['--em-lh-caption', 'var(--lh-caption)'],
  ['--em-lh-body', 'var(--lh-body)'],
  ['--em-lh-title', 'var(--lh-title)'],
  ['--em-lh-heading', 'var(--lh-heading)'],
  ['--em-lh-page', 'var(--lh-page)'],
  ['--em-spacing-xs', 'var(--spacing-xs)'],
  ['--em-spacing-sm', 'var(--spacing-sm)'],
  ['--em-spacing-md', 'var(--spacing-md)'],
  ['--em-spacing-lg', 'var(--spacing-lg)'],
  ['--em-spacing-xl', 'var(--spacing-xl)'],
  ['--em-spacing-2xl', 'var(--spacing-2xl)'],
  ['--em-radius-document', 'var(--radius-document)'],
  ['--em-radius-control', 'var(--radius-control)'],
  ['--em-radius-surface', 'var(--radius-surface)'],
  ['--em-radius-xl', 'var(--radius-xl)'],
  ['--em-radius-dialog', 'var(--radius-dialog)'],
  ['--em-radius-capsule', 'var(--radius-capsule)'],
  ['--em-control-h-sm', 'var(--control-h-sm)'],
  ['--em-control-h-md', 'var(--control-h-md)'],
  ['--em-control-h-lg', 'var(--control-h-lg)'],
  ['--em-control-h-touch', 'var(--control-h-touch)'],
  ['--em-icon-sm', 'var(--icon-sm)'],
  ['--em-icon-md', 'var(--icon-md)'],
  ['--em-icon-lg', 'var(--icon-lg)'],
  ['--em-avatar-xs', 'var(--avatar-xs)'],
  ['--em-avatar-sm', 'var(--avatar-sm)'],
  ['--em-avatar-md', 'var(--avatar-md)'],
  ['--em-avatar-lg', 'var(--avatar-lg)'],
  ['--em-row-pad', 'var(--row-pad)'],
  ['--em-row-gap', 'var(--row-gap)'],
  ['--em-ease', 'var(--ease)'],
  ['--em-dur-fast', 'var(--dur-fast)'],
  ['--em-dur-med', 'var(--dur-med)'],
];

/** The media blocks of tokens.css the App follows, and the media query each becomes in the App page. */
const CONDITIONS = {
  contrast: { source: /^\(prefers-contrast:\s*more\)$/, page: '(prefers-contrast: more)' },
  transparency: { source: /^\(prefers-reduced-transparency:\s*reduce\)$/, page: '(prefers-reduced-transparency: reduce)' },
  // tokens.css raises the body size under the phone shell's width; an App's viewport is its slot, so the page asks
  // the input instead (a 440-wide side panel is still a mouse). Either answer: the Android 14 emulator's WebView 113
  // calls its touch screen `pointer: fine` but `hover: none` (workspace lane, 10-05).
  mobile: { source: /^\(max-width:\s*719px\)$/, page: '(pointer: coarse), (hover: none)' },
};

/**
 * Top-level rules and the rules of top-level @media blocks; @layer / @theme / @keyframes and the rest are skipped.
 * @param {string} css
 * @returns {{ selectors: string[], media: string | null, declarations: [string, string][] }[]}
 */
function parseRules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const block = (from) => {
    // index of the `}` closing the block whose `{` is at from-1
    let depth = 1;
    let j = from;
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
    }
    if (depth !== 0) throw new Error('app palette: unbalanced braces in tokens.css');
    return j - 1;
  };
  const declarationsOf = (body) =>
    body
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('--'))
      .map((part) => {
        const colon = part.indexOf(':');
        return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
      });
  const walk = (start, end, media) => {
    let k = start;
    while (k < end) {
      const open = text.indexOf('{', k);
      if (open === -1 || open >= end) return;
      const prelude = text.slice(k, open).trim();
      const close = block(open + 1);
      const semicolonStatement = prelude.lastIndexOf(';');
      const head = semicolonStatement === -1 ? prelude : prelude.slice(semicolonStatement + 1).trim();
      if (head.startsWith('@media') && media === null) {
        walk(open + 1, close, head.slice('@media'.length).trim());
      } else if (!head.startsWith('@')) {
        rules.push({ selectors: head.split(',').map((s) => s.trim()), media, declarations: declarationsOf(text.slice(open + 1, close)) });
      }
      k = close + 1;
    }
  };
  walk(0, text.length, null);
  return rules;
}

/**
 * The specificity with which a rule reaches `<html>` in this theme, or null when it does not: `:root` (0,1,0) always,
 * `[data-theme=…]` (0,1,0) and `:root[data-theme=…]` (0,2,0) for that theme. Anything else (a platform, a setting
 * that is off by default) does not reach the default `<html>`.
 * @param {string[]} selectors
 * @param {'dark' | 'light'} theme
 */
function reach(selectors, theme) {
  let best = null;
  for (const selector of selectors) {
    let specificity = null;
    if (selector === ':root') specificity = 1;
    const attr = /^(:root)?\[data-theme=(["'])(light|dark)\2\]$/.exec(selector);
    if (attr && attr[3] === theme) specificity = attr[1] ? 2 : 1;
    if (specificity !== null && (best === null || specificity > best)) best = specificity;
  }
  return best;
}

/**
 * Custom properties on `<html>` for one theme under a set of active conditions: tokens.css's cascade (specificity,
 * then source order).
 * @param {ReturnType<typeof parseRules>} rules
 * @param {'dark' | 'light'} theme
 * @param {readonly (keyof typeof CONDITIONS)[]} active
 * @returns {Map<string, string>}
 */
function tokensFor(rules, theme, active) {
  const applicable = [];
  rules.forEach((rule, order) => {
    if (rule.media !== null && !active.some((condition) => CONDITIONS[condition].source.test(rule.media))) return;
    const specificity = reach(rule.selectors, theme);
    if (specificity !== null) applicable.push({ specificity, order, rule });
  });
  applicable.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  const values = new Map();
  for (const { rule } of applicable) for (const [name, value] of rule.declarations) values.set(name, value);
  return values;
}

/**
 * `var(--x)` / `var(--x, fallback)` substituted until none is left; an unknown token without a fallback is an error.
 * @param {string} expression
 * @param {Map<string, string>} tokens
 * @param {readonly string[]} [seen]
 * @returns {string}
 */
function resolve(expression, tokens, seen = []) {
  let out = '';
  let k = 0;
  while (k < expression.length) {
    const at = expression.indexOf('var(', k);
    if (at === -1) return out + expression.slice(k);
    out += expression.slice(k, at);
    let depth = 1;
    let j = at + 4;
    for (; j < expression.length && depth > 0; j++) {
      if (expression[j] === '(') depth++;
      else if (expression[j] === ')') depth--;
    }
    const inner = expression.slice(at + 4, j - 1);
    const comma = inner.indexOf(',');
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? null : inner.slice(comma + 1).trim();
    if (seen.includes(name)) throw new Error(`app palette: ${name} refers to itself (${[...seen, name].join(' → ')})`);
    const value = tokens.get(name);
    if (value !== undefined) out += resolve(value, tokens, [...seen, name]);
    else if (fallback !== null) out += resolve(fallback, tokens, seen);
    else throw new Error(`app palette: ${name} is not a token of tokens.css (needed by ${seen[0] ?? expression})`);
    k = j;
  }
  return out;
}

/** @param {string} selector @param {[string, string][]} declarations */
function block(selector, declarations) {
  return `${selector} {\n${declarations.map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}`;
}

/**
 * The `@layer gugu` block of ui.css that holds the palette and the scales. Without `data-gugu-theme` yet (a page whose
 * host could not say the theme before its first paint — a desktop page can, `GuguHost.theme`) it follows the OS's colour
 * scheme; then `context.themeMode` decides.
 * @param {string} tokensCss
 * @returns {string}
 */
export function appPaletteCss(tokensCss) {
  const rules = parseRules(tokensCss);
  const colorsOf = (theme, active) => {
    const tokens = tokensFor(rules, theme, active);
    return APP_PALETTE_COLORS.map(([name, token]) => [name, resolve(token, tokens, [name])]);
  };
  const dark = colorsOf('dark', []);
  const light = colorsOf('light', []);
  const scaleTokens = tokensFor(rules, 'dark', []);
  const scales = APP_PALETTE_SCALES.map(([name, token]) => [name, resolve(token, scaleTokens, [name])]);
  const changed = (base, next) => next.filter(([, value], index) => value !== base[index][1]);

  const out = ['@layer gugu {', block(':root', scales)];
  out.push(block(':root, :root[data-gugu-theme="dark"]', [['color-scheme', 'dark'], ...dark]));
  out.push(`@media (prefers-color-scheme: light) {\n${block(':root:not([data-gugu-theme])', [['color-scheme', 'light'], ...light])}\n}`);
  out.push(block(':root[data-gugu-theme="light"]', [['color-scheme', 'light'], ...light]));
  for (const condition of ['contrast', 'transparency']) {
    const darkDelta = changed(dark, colorsOf('dark', [condition]));
    const lightDelta = changed(light, colorsOf('light', [condition]));
    if (darkDelta.length === 0 && lightDelta.length === 0) continue;
    const parts = [];
    if (darkDelta.length) parts.push(block(':root, :root[data-gugu-theme="dark"]', darkDelta));
    if (lightDelta.length) parts.push(block(':root[data-gugu-theme="light"]', lightDelta));
    out.push(`@media ${CONDITIONS[condition].page} {\n${parts.join('\n')}\n}`);
  }
  const mobileScales = APP_PALETTE_SCALES.map(([name, token]) => [name, resolve(token, tokensFor(rules, 'dark', ['mobile']), [name])]);
  const mobileDelta = changed(scales, mobileScales);
  if (mobileDelta.length) out.push(`@media ${CONDITIONS.mobile.page} {\n${block(':root', mobileDelta)}\n}`);
  out.push('}');
  return `${out.join('\n')}\n`;
}
