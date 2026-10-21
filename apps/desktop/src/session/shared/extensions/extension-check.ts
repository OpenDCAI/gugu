/**
 * `app_check` (friction F5, 09-29): an agent that installed an App had no way to see it run — it said "done"
 * while the page read "this tab has no vote file bound". The host runs one tab as a hidden page with the context a
 * real open gives it (a group, a file of it), reads back what happened, and closes it. Not a static check (D-18):
 * this is the running App, for the agent to debug with.
 *
 * The agent tool, its argument checks and who may check what are L4's (gugu-extension-tool.ts,
 * extension-agent-actions.ts); the hidden page's life and what it collects are the host's (main,
 * `checkExtensionSurface`). This file is the seam between them.
 */

import { z } from 'zod';
import type { CheckReadings, ExtensionOperator } from './bridge-protocol';

/**
 * How long a check may take in all, at most (F5, S2: a check read at 5 s caught Apps still opening their file and
 * called them fine). The host waits for the load, then for the page's first `files.open(…)` to resolve or reject, then
 * for a quiet moment — each inside this one limit.
 */
export const EXTENSION_CHECK_TIMEOUT_MS = 15_000;

/** Where a check that ran out of time was still waiting. */
export type ExtensionCheckStep = 'load' | 'files.open' | 'quiet';

/**
 * `app_check { steps }` (owner 10-12, described to the agent in gugu-extension-tool.ts): their own time, apart from the
 * load, the settling and the pictures (mac1 10-12: a check without steps ends in 2.4–3.3 s); a step's own wait.
 */
export const EXTENSION_STEPS_TIMEOUT_MS = 15_000;
export const EXTENSION_STEP_WAIT_MS = 5_000;
/** mac1 10-12: 片场's table is 5.1 KB, the other Apps' under 1.4 KB. */
export const EXTENSION_SNAPSHOT_MAX_BYTES = 6 * 1024;
/**
 * `app_check { page }` (owner 10-13): a check's page is kept this long after its last check. Agents' checks one after
 * another in one stretch of work came 31 s to 368 s apart (Chole transcripts 10-06 and 10-13), the next stretch 35 min
 * and more later: twice the longest, and gone well before work of another kind.
 */
export const EXTENSION_CHECK_PAGE_IDLE_MS = 10 * 60_000;
/** One kept page is ~108 MB (mac1 10-13): three let a session hold a panel's and a phone's, and one more. */
export const EXTENSION_CHECK_PAGES_PER_SESSION = 3;
/**
 * And the machine at most this many, ~1 GB: three sessions making Apps at once. Chole (where the owner's agents run) had
 * 7.2 GB of its 31.6 GB free at 10-13 19:2x — not a tenth of that held by pages no one is looking at.
 */
export const EXTENSION_CHECK_PAGES_PER_MACHINE = 9;
/** The keys a `press` step has (owner 10-13): on what has the focus, as a person's key. */
export const EXTENSION_STEP_KEYS = ['Enter', 'Escape', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;
export type ExtensionStepKey = (typeof EXTENSION_STEP_KEYS)[number];
export const isExtensionStepKey = (name: string): name is ExtensionStepKey => (EXTENSION_STEP_KEYS as readonly string[]).includes(name);

const role = z.string().min(1);
const target = z.object({
  role,
  name: z.string().min(1).optional(),
  within: z.union([z.object({ role, name: z.string().min(1) }).strict(), z.object({ role, text: z.string().min(1) }).strict()]).optional(),
}).strict();
const look = z.boolean().optional();
export const EXTENSION_STEP_SCHEMA = z.union([
  z.object({ click: target, look }).strict(),
  z.object({ fill: target, text: z.string(), look }).strict(),
  // Any name here, refused before the steps run (app_check) naming EXTENSION_STEP_KEYS: a union's own error says only "Invalid input".
  z.object({ press: z.string().min(1), look }).strict(),
  z.object({ waitFor: z.union([target, z.object({ text: z.string().min(1) }).strict()]), look }).strict(),
]);
export type ExtensionStepRequest = z.infer<typeof EXTENSION_STEP_SCHEMA>;
export type ExtensionStepTarget = z.infer<typeof target>;

/** What one step did; `ok: null` is a step not run. Its errors, console, writes and shown are only what is new since the step before. */
export interface ExtensionStepResult {
  step: number;
  ok: boolean | null;
  did?: string;
  error?: string;
  /** Several matched, or none: those of that role, each with the `within` that would tell it apart. */
  candidates?: string[];
  errors?: ExtensionCheckReport['errors'];
  console?: ExtensionCheckReport['console'];
  /** How often the page wrote its files during the step, and what it handed back instead of the person's screen. */
  writes?: number;
  shown?: CheckReadings['shown'];
}

export interface ExtensionCheckRequest {
  extensionId: string;
  /** Installed, switched on and a tab of this extension — checked before the host is asked. */
  tabName: string;
  /** A group the calling agent is in (checked, like the file, as that agent). */
  chatId?: string;
  /** A file of that group: the page is opened for it, exactly as "open with" would. */
  itemId?: string;
  /**
   * F94 In a session: the caller's session, as a tab of it — opened for a file of its working copy (relative), or, for a
   * tab that claims no file, the App's own page (owner 10-13).
   */
  sessionId?: string;
  filePath?: string;
  timeoutMs: number;
  /** Done once it settled, at one size: where it opens with a mouse, or a phone's width with touch (`phone`). */
  steps?: ExtensionStepRequest[];
  phone?: boolean;
  /** The session asking: a page it opens is kept for it alone to go on with (absent: closed after this check). */
  caller?: string;
  /** Who works the page (owner 10-14): the agent of the session asking — never the person, whose screen it is not on. */
  operator: Extract<ExtensionOperator, { kind: 'agent' }>;
  /** Go on with this kept page of the caller's (`report.page` of an earlier check) instead of opening one. */
  page?: string;
}

export interface ExtensionCheckReport {
  /** The page finished loading and its scripts ran. */
  loaded: boolean;
  /** Why it did not: failed to load, crashed, timed out. */
  loadError: string | null;
  /**
   * What the page reported (`gugu.reportError`) or threw (uncaught errors, unhandled rejections). `level`: `hint` is
   * a note for the App's author (a file written every frame, 摩擦单 F62), not a sign the App is broken.
   */
  errors: {
    /**
     * `static`: read in the bundle's scripts, not seen running (摩擦单 F96) — always a hint. `program`: one of its MCP
     * programs did not start or list its tools (F77: a tools module that is not all tools stops, naming the export).
     * `skill`: one of its skills no session gets — its SKILL.md could not be read (skill 注入核查 10-14).
     */
    kind: 'reportError' | 'uncaught' | 'unhandledrejection' | 'static' | 'program' | 'skill';
    level: 'error' | 'hint';
    message: string;
    /** Where a thrown error was: `<file in the bundle>:<line>`, and that line of the source (F75: less to guess). */
    source?: string;
    line?: string;
  }[];
  console: { level: 'error' | 'warning'; message: string }[];
  /**
   * What Electron's own scripts said while they started the page (`node:electron/…`, before or beside the App's): gugu's
   * failure, never the App's — kept out of `console` and not counted against it (#7126: Electron's sandbox bootstrap
   * failed once in four checks of an App that worked, and the agent was told to fix its App). Absent when there was none.
   */
  host?: { level: 'error' | 'warning'; message: string }[];
  /**
   * What the page shows at the end, as its accessibility tree outlines it (ARIA YAML: role, name, state, value — what a
   * step names); at most EXTENSION_SNAPSHOT_MAX_BYTES. Replaced the first 1 KB of its text.
   */
  snapshot: string;
  /** `steps`, one result each, in order. */
  steps?: ExtensionStepResult[];
  /** Out of time: the step it was still waiting on. Absent when it settled. */
  stuck?: ExtensionCheckStep;
  /**
   * What this App's real pages recorded (errors and hints) since this version was installed, newest last (摩擦单 F68,
   * S16: a real page had hinted at 9 s, the check said `errors: []`, and the agent told the person all was well).
   */
  pages: { at: string; level: 'error' | 'hint'; message: string; page: { tabKind: string; chatId: string | null; itemId: string | null; sessionId: string | null } }[];
  /**
   * What the check's page did (摩擦单 F69), for the agent to read: how often it wrote and set presence, and what it handed
   * back instead of the person's screen (owner 10-14).
   */
  readings?: CheckReadings;
  /** 摩擦单 F77 The tools its programs give agents, by name, as they list them now (absent: it has no programs). */
  tools?: string[];
  /**
   * What the page looks like (extension-look-picture.ts): where it opens, and on a phone if it goes there, light and dark
   * — for the agent to look at before it says the App is done. Absent when the page never loaded, or the host could not
   * take them (in its log).
   */
  pictures?: ExtensionPicture[];
  /** The page kept for the caller to go on with (`page`); absent when it was not kept. */
  page?: string;
  elapsedMs: number;
}

/** A picture for an agent: an MCP image block (the tool registrar turns it into one), said by `label`. */
export interface ExtensionPicture {
  label: string;
  mimeType: 'image/jpeg';
  /** base64 */
  data: string;
}
