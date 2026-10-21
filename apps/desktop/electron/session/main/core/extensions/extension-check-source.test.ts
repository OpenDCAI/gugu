import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sourceLine, staticHints } from './extension-check-source';

/**
 * 摩擦单 F75 (S19): `app_check` reported "Cannot read properties of null (reading 'getContext')" and nothing else; the
 * agent guessed "canvas compatibility", then "the static check removes empty nodes", about two minutes of it. What the
 * console already knows — which file of the bundle, which line — and that line's source come back with the error.
 */
let root = '';
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'check-source-'));
  mkdirSync(path.join(root, 'js'));
  writeFileSync(path.join(root, 'app.js'), "import { $ } from '/_gugu/1/glue.js'\n\nconst ctx = $('board').getContext('2d')\n");
  writeFileSync(path.join(root, 'js', 'draw.js'), 'a\r\nb\r\n    drawStroke(points)   \r\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('a thrown error says where it was: the file of the bundle, its line, and that line (F75)', () => {
  it('reads the line out of the installed bundle, trimmed', () => {
    expect(sourceLine('draw-guess', root, 'gugu-ext://draw-guess/app.js', 3)).toEqual({
      source: 'app.js:3',
      line: "const ctx = $('board').getContext('2d')",
    });
    expect(sourceLine('draw-guess', root, 'gugu-ext://draw-guess/js/draw.js', 3)).toEqual({ source: 'js/draw.js:3', line: 'drawStroke(points)' });
  });

  it('a line past the end, or a file it cannot read: the place, no line', () => {
    expect(sourceLine('draw-guess', root, 'gugu-ext://draw-guess/app.js', 40)).toEqual({ source: 'app.js:40' });
    expect(sourceLine('draw-guess', root, 'gugu-ext://draw-guess/missing.js', 1)).toEqual({ source: 'missing.js:1' });
  });

  it('never outside the bundle: another App, the platform runtime, no source at all — and a climbing path stays inside', () => {
    expect(sourceLine('draw-guess', root, 'gugu-ext://other-app/app.js', 3)).toBeNull();
    expect(sourceLine('draw-guess', root, 'https://example.com/app.js', 3)).toBeNull();
    expect(sourceLine('draw-guess', root, undefined, 1)).toBeNull();
    // The URL resolves its dot segments first: this names the bundle's own etc/passwd, which is not there — nothing read.
    expect(sourceLine('draw-guess', root, 'gugu-ext://draw-guess/%2e%2e/%2e%2e/etc/passwd', 1)).toEqual({ source: 'etc/passwd:1' });
  });
});

// 摩擦单 F96: an App page has no alert / confirm / prompt (a stopping dialog would freeze the host; a phone has none) —
// app_check reads the bundle's scripts and hints at each call, with its line. Only a hint: text can look like code.
describe('the bundle\'s scripts read for what cannot work in an App page (F96)', () => {
  it('a bare call, or one on window / globalThis: a hint with its file, line and that line', () => {
    writeFileSync(path.join(root, 'app.js'), "const ok = confirm('Delete?')\nif (ok) window.alert('gone')\n");
    writeFileSync(path.join(root, 'js', 'draw.js'), 'const name = globalThis.prompt("Your name?")\n');
    const hints = staticHints(root);
    expect(hints.map((hint) => [hint.source, hint.line])).toEqual([
      ['app.js:1', "const ok = confirm('Delete?')"],
      ['app.js:2', "if (ok) window.alert('gone')"],
      ['js/draw.js:1', 'const name = globalThis.prompt("Your name?")'],
    ]);
    expect(hints[0]!.message).toMatch(/^confirm\(\) does not exist in an App page .* ask on the page — an input, a button/);
  });

  it('control: an object\'s own method, a longer name, a comment, a dependency folder — no hint', () => {
    writeFileSync(path.join(root, 'app.js'), [
      'await gugu.confirm(entry)',
      'dialog.prompt()',
      'const reconfirm = myalert(1)',
      '// never alert() the person',
      ' * or prompt() them',
    ].join('\n'));
    writeFileSync(path.join(root, 'js', 'draw.js'), 'drawStroke(points)\n');
    mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), 'alert(1)\n');
    expect(staticHints(root)).toEqual([]);
  });
});
