import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_PALETTE_COLORS, APP_PALETTE_SCALES, appPaletteCss } from './app-palette.mjs';

/**
 * The App palette is this build's tokens.css, both themes, resolved at build into ui.css (buildAppRuntime). Before it,
 * the host sent the `--em-*` values computed where the App's frame sat: the session page's own on the desktop, and in a
 * group's iframe on the phone and the web session-ui's raw palette (a jade-green primary, measured on WebView 113).
 */
const tokens = readFileSync(new URL('../../../styles/tokens.css', import.meta.url), 'utf-8');
const css = appPaletteCss(tokens);

/** The declarations of the first block whose selector is exactly `selector` (optionally inside `@media media`). */
function block(selector: string, media?: string): Map<string, string> {
  const scope = media ? css.slice(css.indexOf(`@media ${media} {`)) : css;
  const at = scope.indexOf(`${selector} {\n`);
  if (at < 0) throw new Error(`no block ${selector}${media ? ` in ${media}` : ''}`);
  const body = scope.slice(at + selector.length + 3, scope.indexOf('\n}', at));
  return new Map(
    body.split('\n').map((line) => {
      const [name, ...value] = line.trim().replace(/;$/, '').split(': ');
      return [name!, value.join(': ')] as const;
    }),
  );
}

describe('the App palette, from tokens.css', () => {
  const dark = block(':root, :root[data-gugu-theme="dark"]');
  const light = block(':root[data-gugu-theme="light"]');

  it('gives every name in both themes, fully resolved', () => {
    for (const [name] of APP_PALETTE_COLORS) {
      expect(dark.get(name), `${name} dark`).toBeTruthy();
      expect(light.get(name), `${name} light`).toBeTruthy();
      expect(`${dark.get(name)} ${light.get(name)}`, name).not.toContain('var(');
    }
    expect(dark.get('color-scheme')).toBe('dark');
    expect(light.get('color-scheme')).toBe('light');
  });

  it('is gugu\'s: the background is --bg, the primary is ink — not session-ui\'s jade', () => {
    const bgDark = /--bg:\s*([^;]+);/.exec(tokens)![1]!;
    expect(dark.get('--em-background')).toBe(bgDark);
    // Ink = the foreground (#7333 Codex master): near-white on dark, near-black on light; never the jade display-p3(0 .63 .46).
    expect(dark.get('--em-accent-9')).toBe(dark.get('--em-foreground'));
    expect(light.get('--em-accent-9')).toBe(light.get('--em-foreground'));
    expect(light.get('--em-accent-9')).toBe('#1a1c1f');
    // The red button's label is white in both themes (the host's ui/Button danger); the ink's inverse stays theme-bound.
    expect(dark.get('--em-color-white')).toBe('#fff');
    expect(light.get('--em-color-white')).toBe('#fff');
    expect(dark.get('--em-accent-contrast')).not.toBe(light.get('--em-accent-contrast'));
    expect(css).not.toMatch(/display-p3/);
    expect(dark.get('--em-background')).not.toBe(light.get('--em-background'));
  });

  it('gives the keyboard focus ring the host\'s colour: --focus-ring, the --live blue of each theme (#7333)', () => {
    // --focus-ring sits in a theme-free block and points at --live, which each theme sets: the ring must follow the theme.
    expect(dark.get('--em-focus-ring')).toBe(dark.get('--em-foreground-info'));
    expect(light.get('--em-focus-ring')).toBe(light.get('--em-foreground-info'));
    expect(dark.get('--em-focus-ring')).not.toBe(light.get('--em-focus-ring'));
  });

  it('keeps the names Apps use, and gives the template\'s --em-background-muted a value at last', () => {
    for (const name of ['--em-background', '--em-foreground', '--em-border', '--em-foreground-muted', '--em-foreground-destructive',
      '--em-accent-9', '--em-accent-contrast', '--em-surface', '--em-background-3', '--em-accent-11', '--em-background-muted']) {
      expect(dark.has(name), name).toBe(true);
    }
    expect(dark.get('--em-background-muted')).toBe(dark.get('--em-background-3'));
  });

  it('follows the OS contrast and transparency settings as tokens.css does', () => {
    const contrast = block(':root, :root[data-gugu-theme="dark"]', '(prefers-contrast: more)');
    expect(contrast.get('--em-border')).toContain('55%');
    const solid = block(':root, :root[data-gugu-theme="dark"]', '(prefers-reduced-transparency: reduce)');
    expect(solid.get('--em-hover')).not.toContain('transparent');
    // #7333: the body is 14 everywhere, so the phone needs no raise of its own (#1787's 14 floor holds).
    expect(css).not.toContain('(pointer: coarse), (hover: none)');
  });

  it('gives the scales once, theme-free', () => {
    const scales = block(':root');
    for (const [name] of APP_PALETTE_SCALES) expect(scales.get(name), name).toMatch(/\S/);
    expect(scales.get('--em-font-body')).toBe('14px');
    expect(scales.get('--em-radius-control')).toBe('8px');
    // #7333 the dialog's corners are the host's dialog role, not the card's surface 12.
    expect(scales.get('--em-radius-dialog')).toBe('16px');
    expect(scales.get('--em-radius-xl')).toBe('12px');
  });

  it('gives the dialog the host\'s dialog shadow in each theme, apart from the lift (#7333)', () => {
    expect(dark.get('--em-shadow-dialog')).toBe(/--shadow-dialog:\s*([^;]+);/.exec(tokens)![1]!.trim());
    expect(dark.get('--em-shadow-dialog')).not.toBe(light.get('--em-shadow-dialog'));
    expect(dark.get('--em-shadow-dialog')).not.toBe(dark.get('--em-shadow-lift'));
  });

  it('fails the build on a token tokens.css does not have, naming it', () => {
    expect(() => appPaletteCss(':root { --fg: #000; }')).toThrow(/--bg is not a token of tokens.css \(needed by --em-background\)/);
  });

  it('applies tokens.css by specificity, then source order', () => {
    const resolveOnly = (source: string) => {
      const filler = APP_PALETTE_COLORS.concat(APP_PALETTE_SCALES).map(([, token]) => /var\((--[^),]+)/.exec(token)![1]!);
      const base = `:root { ${filler.map((name) => `${name}: 1px;`).join(' ')} }`;
      return appPaletteCss(`${base}\n${source}`);
    };
    // A later :root (0,1,0) does not beat an earlier :root[data-theme="light"] (0,2,0) in the light theme.
    const out = resolveOnly(':root[data-theme="light"] { --bg: red; }\n:root { --bg: blue; }');
    expect(out).toMatch(/:root\[data-gugu-theme="light"\] \{[^}]*--em-background: red;/);
    expect(out).toMatch(/:root, :root\[data-gugu-theme="dark"\] \{[^}]*--em-background: blue;/);
  });
});
