import fs from 'node:fs';
import path from 'node:path';
import { noPageDialog, type PageDialog } from '@shared/extensions/app-runtime-protocol';

/** A source line quoted with a thrown error is cut at this many characters. */
const LINE_MAX_CHARS = 200;
/** A bundle's scripts read for the static hints: this many files, each up to this size, at most. */
const SCAN_MAX_FILES = 200;
const SCAN_MAX_BYTES = 512 * 1024;

/**
 * What the bundle's own scripts say that will not work, found by reading them — a hint for the author, never a failure:
 * a line is only text, and a comment or a string can look like a call. A static rule is only for a runtime refusal the
 * check's page cannot reach (审计 A4): what fails as the page loads, the check sees run, with its line (F75).
 *
 * 摩擦单 F96 `alert` / `confirm` / `prompt` (called bare or on `window` / `globalThis` / `self`, not as some object's
 * method) do not exist in an App page — a dialog that stops the page would freeze the host, and a phone's sandbox has
 * none — and they sit in click handlers the check never clicks. Said in the runtime's own sentence (L3).
 */
const STATIC_RULES: { test: RegExp; say: (match: RegExpExecArray) => string }[] = [
  {
    test: /(?<![\w$.])(?:window\.|globalThis\.|self\.)?(alert|confirm|prompt)\s*\(/,
    say: (match) => noPageDialog(match[1] as PageDialog),
  },
];

export interface StaticHint {
  message: string;
  source: string;
  line: string;
}

/** The static hints for one installed bundle: each with its file, line and that line. */
export function staticHints(rootDir: string): StaticHint[] {
  const hints: StaticHint[] = [];
  for (const rel of scripts(rootDir)) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(rootDir, rel), 'utf8');
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((raw, index) => {
      const code = raw.trim();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
      for (const rule of STATIC_RULES) {
        const match = rule.test.exec(raw);
        if (match) hints.push({ message: rule.say(match), source: `${rel}:${index + 1}`, line: code.slice(0, LINE_MAX_CHARS) });
      }
    });
  }
  return hints;
}

/** The bundle's scripts (.js / .mjs), bundle-relative with `/`, dependencies' folders left out. */
function scripts(rootDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= SCAN_MAX_FILES) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.m?js$/.test(entry.name) && fs.statSync(full).size <= SCAN_MAX_BYTES) {
        found.push(path.relative(rootDir, full).split(path.sep).join('/'));
      }
    }
  };
  walk(rootDir);
  return found.sort();
}

/**
 * F75 (S19: an agent guessed twice what a bare "Cannot read properties of null" meant) A thrown error's place in the
 * bundle — `app.js:12` — and that line of the source, read from the installed bundle. Null for anything outside it.
 */
export function sourceLine(
  extensionId: string,
  rootDir: string,
  sourceId: string | undefined,
  lineNumber: number
): { source: string; line?: string } | null {
  if (!sourceId) return null;
  let url: URL;
  try {
    url = new URL(sourceId);
  } catch {
    return null;
  }
  if (url.protocol !== 'gugu-ext:' || url.hostname !== extensionId) return null;
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(rootDir, rel);
  if (!rel || path.relative(rootDir, file).startsWith('..')) return null;
  const source = `${rel}:${lineNumber}`;
  try {
    const text = fs.readFileSync(file, 'utf8').split(/\r?\n/)[lineNumber - 1];
    return text === undefined ? { source } : { source, line: text.trim().slice(0, LINE_MAX_CHARS) };
  } catch {
    return { source };
  }
}
