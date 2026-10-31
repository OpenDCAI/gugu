import type { FilePlace } from '@gugu/core/shared/ui/guguLink';
import { claimedSuffixes, type ExtensionManifest, type FileOpenContext } from './manifest';

/**
 * Which installed tab offers to open a given file (behavior tab-extensions:
 *「认领某类文件的打开方式」).
 *
 * An OFFER, never a seizure. Everything here returns candidates and orders them;
 * nothing here opens anything, and the built-in editor is not consulted, replaced
 * or removed. That division is the whole safety story: installing an extension
 * must not be able to make a file unopenable, so the decision of what actually
 * opens stays with the caller — and with the user.
 *
 * Ordering is stable and stated rather than incidental, because "which one wins"
 * is a thing a user will ask about: longer suffix first (`.tar.gz` beats `.gz`),
 * then extension id, then tab name. Install order deliberately does NOT
 * participate — it would make the answer depend on a history nobody can see.
 */
export interface FileOpenerCandidate {
  extensionId: string;
  /** `<extensionId>.<tabName>` — the tab kind the host opens. */
  tabKind: string;
  tabTitle: string;
  /**
   * The App's name — what a person tells Apps apart by in 「用哪个打开」 (摩擦单 F26) — as its manifest gives it, in every
   * language it gives it: whoever draws it picks one with `localizedManifestText` (the candidate is made in main and on
   * the phone as well as in the window, and only the drawing side knows the language).
   */
  app: Pick<ExtensionManifest, 'name' | 'defaultLocale' | 'localized'>;
  /** The App has this one tab: its title adds nothing under the App's name. */
  onlyTab: boolean;
  /**
   * The claim that matched, lowercased: a suffix (`.csv`) or a file name (`todo.md`, `todo-*.md`, 摩擦单 F82). It is
   * also what a remembered 「始终用它」 is kept under (`openWithKey`).
   */
  suffix: string;
  /**
   * The file is this App's own state in a chat: the tab names it as its `chatFile` (App 模型 v2 — the one sign of App
   * data; the folder hides such files until 「显示 App 数据」). A file claimed by suffix is a person's document.
   */
  state: boolean;
}

/**
 * App 引用 pill (148 17:21): what the App that opens a file is told about the place a pill points at (its link's `#…`) —
 * the one `link` event a gugu link brings (`gugu.onLink`): `tab` the tab that opens the file, `path` empty, `query` the
 * place's keys and values, `file` the file's id (#7257: the place is that file's). Main sends it on the desktop
 * (`groupFileOpener`), the phone's host on the phone.
 */
export function placeLink(
  candidate: Pick<FileOpenerCandidate, 'extensionId' | 'tabKind'>,
  at: FilePlace,
  file: string,
): { type: 'link'; tab: string; path: string; query: Record<string, string>; file: string } {
  return { type: 'link', tab: candidate.tabKind.slice(candidate.extensionId.length + 1), path: '', query: { ...at }, file };
}

/**
 * The place a chat file is opened at (`at`: a link's `#…`, or an App's `files.openWith(entry, { at })`) and the App told
 * it: only when one App opens the file (several: the person picks, and no App is told) and `at` names a place — its string
 * keys and values, as `placeLink` hands them on.
 */
export function placeFor(choice: OpenerChoice, at: unknown): { candidate: FileOpenerCandidate; at: FilePlace } | null {
  if (choice.kind !== 'one' || !at || typeof at !== 'object') return null;
  const place = Object.fromEntries(Object.entries(at).filter(([, value]) => typeof value === 'string')) as FilePlace;
  return Object.keys(place).length > 0 ? { candidate: choice.candidate, at: place } : null;
}

/**
 * How specific a claim is (摩擦单 F82): a file name beats any pattern, a pattern (`todo-*.md`) beats any suffix;
 * within each, the more of it is spelled out the better (`.tar.gz` before `.gz`, `todo-2026-*.md` before `todo-*.md`).
 */
function specificity(claim: string): [kind: number, length: number] {
  if (claim.startsWith('.')) return [0, claim.length];
  if (claim.includes('*')) return [1, claim.replace(/\*/g, '').length];
  return [2, claim.length];
}

const patterns = new Map<string, RegExp>();
/** A file-name claim with `*` (any run of characters), as a whole-name match. */
function patternOf(claim: string): RegExp {
  let pattern = patterns.get(claim);
  if (!pattern) {
    pattern = new RegExp(`^${claim.split('*').map((part) => part.replace(/[.+^${}()|[\]\\?-]/g, '\\$&')).join('.*')}$`);
    patterns.set(claim, pattern);
  }
  return pattern;
}

/** Whether a claim takes this file: its suffixes (`suffixesOf`), or its name. */
function claims(claim: string, name: string, suffixes: ReadonlySet<string>): boolean {
  if (claim.startsWith('.')) return suffixes.has(claim);
  return claim.includes('*') ? patternOf(claim).test(name) : name === claim;
}

/** Lowercased so a claim on `.csv` still matches `REPORT.CSV` on disk. */
function suffixesOf(filePath: string): string[] {
  const name = filePath.split(/[\\/]/).pop() ?? '';
  const lower = name.toLowerCase();
  const out: string[] = [];
  // Every dot-led tail, so a `.tar.gz` claim and a `.gz` claim both get a chance
  // to match and the longer one can win. A leading dot is a hidden file, not a
  // suffix: `.gitignore` must not read as a claim on `.gitignore` files.
  for (let i = 1; i < lower.length; i += 1) {
    if (lower[i] === '.') out.push(lower.slice(i));
  }
  return out;
}

/** Whether one claim (a suffix or a file name, as a manifest keeps it) takes a file of this name — `fileOpenersFor`'s rule. */
export function claimTakes(claim: string, fileName: string): boolean {
  return claims(claim, (fileName.split(/[\\/]/).pop() ?? '').toLowerCase(), new Set(suffixesOf(fileName)));
}

/**
 * `context` is where the file lives: a tab offers to open only the files it claimed there
 * (`opensFiles`).
 */
export function fileOpenersFor(
  filePath: string,
  installed: readonly ExtensionManifest[],
  context: FileOpenContext = 'session'
): FileOpenerCandidate[] {
  const present = new Set(suffixesOf(filePath));
  const name = (filePath.split(/[\\/]/).pop() ?? '').toLowerCase();
  const candidates: FileOpenerCandidate[] = [];
  for (const manifest of installed) {
    for (const tab of manifest.contributes.tabs) {
      for (const claimed of claimedSuffixes(tab, context)) {
        if (!claims(claimed, name, present)) continue;
        candidates.push({
          extensionId: manifest.id,
          tabKind: `${manifest.id}.${tab.name}`,
          tabTitle: tab.title,
          app: { name: manifest.name, defaultLocale: manifest.defaultLocale, ...(manifest.localized ? { localized: manifest.localized } : {}) },
          onlyTab: manifest.contributes.tabs.length === 1,
          suffix: claimed,
          state: context === 'chat' && tab.chatFile?.toLowerCase() === name,
        });
      }
    }
  }
  return candidates.sort((a, b) => {
    const [kindA, lengthA] = specificity(a.suffix);
    const [kindB, lengthB] = specificity(b.suffix);
    return kindB - kindA || lengthB - lengthA || a.extensionId.localeCompare(b.extensionId) || a.tabKind.localeCompare(b.tabKind);
  });
}

/** What opening a file comes to (真源 §2.4, 主人 09-29): nobody claims it, one App does, or the person picks. */
export type OpenerChoice =
  | { kind: 'none' }
  | { kind: 'one'; candidate: FileOpenerCandidate }
  | { kind: 'choose'; suffix: string; candidates: FileOpenerCandidate[] };

/**
 * A file's name as a person reads it (摩擦单 F39): without the suffix it is claimed by — `friday-dinner` for
 * `friday-dinner.vote.json` claimed as `.vote.json`. The file list and the 「用 X 打开」 picker say it the same way (F73).
 */
export function displayNameOf(fileName: string, claimedSuffix: string): string {
  const shortened = fileName.toLowerCase().endsWith(claimedSuffix.toLowerCase()) ? fileName.slice(0, -claimedSuffix.length) : '';
  return shortened || fileName;
}

/** The key a remembered 「始终用它」 is kept under: one per context and suffix. */
export function openWithKey(context: FileOpenContext, suffix: string): string {
  return `${context}:${suffix}`;
}

/** Each App once, most specific claim first (the candidates come sorted that way). */
function oncePerTab(candidates: readonly FileOpenerCandidate[]): FileOpenerCandidate[] {
  const out: FileOpenerCandidate[] = [];
  for (const candidate of candidates) {
    if (!out.some((c) => c.tabKind === candidate.tabKind)) out.push(candidate);
  }
  return out;
}

/**
 * Like an operating system opening a file (a double click): the person's 「始终用它」 for this kind
 * of file wins, if that App still opens it at all; otherwise the most specific suffix claimed
 * decides who is in the running (`.vote.json` over `.json`, `.tar.gz` over `.gz`) — one App there
 * opens it straight away, several and the host asks. 「始终用它」 is kept under the file's most
 * specific claimed suffix, whichever App was picked.
 */
export function chooseOpener(
  candidates: readonly FileOpenerCandidate[],
  remembered: (suffix: string) => string | null
): OpenerChoice {
  const first = candidates[0];
  if (!first) return { kind: 'none' };
  const saved = remembered(first.suffix);
  const chosen = candidates.find((candidate) => candidate.tabKind === saved);
  if (chosen) return { kind: 'one', candidate: chosen };
  const running = oncePerTab(candidates.filter((candidate) => candidate.suffix === first.suffix));
  return running.length === 1 ? { kind: 'one', candidate: running[0]! } : { kind: 'choose', suffix: first.suffix, candidates: running };
}

/**
 * 「用别的 App 打开」 (a right click's 「打开方式」): every App that opens this file, the less specific
 * claims too (a `.vote.json` file also lists who opens `.json`) — the person always picks.
 */
export function askOpener(candidates: readonly FileOpenerCandidate[]): OpenerChoice {
  const first = candidates[0];
  if (!first) return { kind: 'none' };
  return { kind: 'choose', suffix: first.suffix, candidates: oncePerTab(candidates) };
}

/**
 * Who opens this file here, among the Apps on this device: what a tap opens (`chooseOpener`, the person's 「始终用它」
 * first) — or, with `ask`, everyone who could (「用别的 App 打开」). One answer wherever a file is opened from — a page's
 * `gugu.files.openWith`, a file link, an App card's 「Open」 — on the desktop (main) and the phone (its outer page, L9).
 * `remembered` reads a 「始终用它」 by its key (`openWithKey`).
 */
export function openerChoice(
  fileName: string,
  apps: readonly ExtensionManifest[],
  context: FileOpenContext,
  remembered: (key: string) => string | null,
  ask = false
): OpenerChoice {
  const openers = fileOpenersFor(fileName, apps, context);
  return ask ? askOpener(openers) : chooseOpener(openers, (suffix) => remembered(openWithKey(context, suffix)));
}

/**
 * The App a file is shown as belonging to (摩擦单 F39): the one a tap opens — or, when the person would pick, the first
 * in line. Null when no App here opens it.
 */
export function claimantOf(
  fileName: string,
  apps: readonly ExtensionManifest[],
  context: FileOpenContext,
  remembered: (key: string) => string | null
): FileOpenerCandidate | null {
  const choice = openerChoice(fileName, apps, context, remembered);
  return choice.kind === 'one' ? choice.candidate : choice.kind === 'choose' ? (choice.candidates[0] ?? null) : null;
}

/**
 * An App of `others` (not installed here, or only older) that would open this file ahead of every installed one (摩擦单
 * F15): the first of one ranking over both, as a tap ranks (name over pattern over suffix, F82). None when an installed App
 * makes the same claim — it opens the file already.
 */
export function openerAhead(
  fileName: string,
  installed: readonly ExtensionManifest[],
  others: readonly ExtensionManifest[],
  context: FileOpenContext
): FileOpenerCandidate | null {
  const best = fileOpenersFor(fileName, [...installed, ...others], context)[0];
  if (!best || fileOpenersFor(fileName, installed, context).some((here) => here.suffix === best.suffix)) return null;
  return best;
}
