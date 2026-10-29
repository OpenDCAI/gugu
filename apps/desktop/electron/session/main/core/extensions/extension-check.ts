import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { log } from '@main/lib/logger';
import { CHECK_PAGE_ARG, type CheckReadings } from '@shared/extensions/bridge-protocol';
import {
  EXTENSION_CHECK_PAGE_IDLE_MS,
  EXTENSION_CHECK_PAGES_PER_MACHINE,
  EXTENSION_CHECK_PAGES_PER_SESSION,
  EXTENSION_STEP_WAIT_MS,
  EXTENSION_STEPS_TIMEOUT_MS,
  type ExtensionCheckReport,
  type ExtensionCheckRequest,
  type ExtensionCheckStep,
  type ExtensionPicture,
} from '@shared/extensions/extension-check';
import { opensInChats } from '@shared/extensions/manifest';
import { extensionPartition, extensionResourceUrl } from '@shared/extensions/partition';
import { resolveExtensionBridgePreload } from './bridge-preload-path';
import { sourceLine, staticHints } from './extension-check-source';
import {
  bindExtensionSurface,
  recentExtensionErrors,
  checkReadingsOf,
  reportBlockedNavigation,
  showAgentPageInTheme,
  shownTabWidth,
  watchExtensionSurfaceErrors,
} from './extension-bridge';
import { ariaSnapshot, byDeadline, readTree, runSteps, type StepHost } from './extension-check-steps';
import { endPictures, GROUP_PANEL, keepPainting, PHONE, PICTURE_MAX_HEIGHT, pictureOf, picturesOf, showAtSize, taskPane, type PictureSize } from './extension-look-picture';
import { agentToolsOf, extensionPrograms, programFailureReason } from './extension-programs';
import { configureExtensionSession } from './extension-session';
import { isAllowedExtensionNavigation } from './extension-webview-security';
import { readExtensionSkills } from '../../../../extension-session-mcp';
import { extensionsService } from './extensions-root';

/** After it loaded and its file opened: done once nothing on the page changed for this long. */
const QUIET_MS = 500;
const POLL_MS = 200;
/** The check's page reports its counts at most every 250 ms (L3, F69): read them this long after it settled. */
const COUNTS_LAG_MS = 300;
/**
 * What every wait on the page says when its main thread did not answer in time (a loop: review r1's Electron 44 probe,
 * `executeJavaScript` and CDP never answer it). The page's failure, never gugu's: once heard, the check reads it as not
 * settled and asks the page nothing more.
 */
const SILENT = 'the page stopped answering';
/**
 * A read of the page gets this long at least, even past a settle's limit: a page that answers is never called silent
 * because the loop's last read raced a timer already at 0 (review r3, Electron 44: a page changing its text every 100 ms
 * was called silent in 4 of 20 two-second settles).
 */
const READ_MIN_MS = 1_000;
/** Where Electron's own scripts run from, as a console message names its source (`node:electron/js2c/sandbox_bundle`). */
const ELECTRON_SCRIPT_PREFIX = 'node:electron/';

/**
 * `app_check` (摩擦单 F5): run one tab of an installed App as a hidden page, exactly as a person
 * opening it would get it, and read back what happened. The page stays for the session that asked to go on with
 * (`page`, owner 10-13), until it is left unused, crowded out or its session ends (`CheckPage`).
 *
 * - **The same binding as a real open, where it opens (owner 10-13).** With a `chatId` (and an `itemId`) it is the
 *   group's page for that file, as 「用 X 打开」 makes it: no task, `context.chat` / `context.file` set,
 *   `files.open(ctx.file)` gives that file — 520 wide, as the group's panel opens. With a `sessionId` it is a tab of that
 *   session (a file of its working copy, or the App's own page), as wide as that tab is shown there now, else 952.
 *   Bound BEFORE it loads — main made this page, so it has its id at once — so the App's first call already has its
 *   context.
 * - **Say too much rather than too little.** Whatever the App says or throws: `gugu.reportError`,
 *   uncaught errors and rejections, console errors and warnings, and what the page shows (an App
 *   that shows "no file bound" is read back saying so).
 * - **Read when it has settled (F5)**: loaded, every `files.open(…)` it called resolved or rejected (its runtime says so
 *   in its counts), then nothing changed for QUIET_MS — all inside `timeoutMs`. Out of time, the report
 *   says which step it was still on (`stuck`). What the page shows is read back as its accessibility tree's outline
 *   (`snapshot`), for the agent to judge: the check guesses nothing about it (摩擦单 F103: a "blank" guess failed Apps
 *   that painted late under load).
 * - **Worked by the agent that asks (owner 10-14)**: its files, its sends and the agents it tells or starts are real, done
 *   as that agent; what would reach the person's screen is handed back to it instead — and what it did comes back
 *   (`readings`). The App's own storage is its real one (owner 10-13): its data, its programs, its localStorage.
 * - **Steps (owner 10-12)**: once it settled, what the agent asked to click, fill, call and wait for, at one size, each
 *   settled before the next (`extension-check-steps.ts`); the snapshot and a picture are of where they left it.
 */
export async function checkExtensionSurface(request: ExtensionCheckRequest): Promise<ExtensionCheckReport> {
  const started = Date.now();
  // A file is a file of one group: which, the caller says (it looked it up as the agent) — never guessed here.
  if (request.itemId && !request.chatId) {
    throw new Error('app_check: a file (itemId) needs its chat (chatId) too — the caller resolves it');
  }
  const report = emptyReport();
  const deadline = started + request.timeoutMs;
  let silent = false;
  /** Whether `error` is the page not answering (and from now on it is not asked again). */
  const heard = (error: unknown) => (silent ||= error instanceof Error && error.message === SILENT);
  const service = extensionsService();
  const installed = service.get(request.extensionId);
  const tab = installed.manifest.contributes.tabs.find((candidate) => candidate.name === request.tabName);
  if (!tab) throw new Error(`"${request.tabName}" is not a tab of App "${request.extensionId}"`);
  if (tab.hostPage) throw new Error('This App uses the host settings page; open it to review configuration and program status.');
  const kept = request.page === undefined ? null : keptPage(request.page, request);
  const page = kept ?? openPage(request);
  // What it said while no check ran (between this one and the last) is this one's.
  report.errors.push(...page.report.errors);
  report.console.push(...page.report.console);
  if (page.report.host) report.host = [...page.report.host];
  page.report = report;
  page.busy = true;
  if (page.idle) clearTimeout(page.idle);
  const contents = page.win.webContents;
  const changed = () => {
    page.lastChange = Date.now();
  };

  try {
    if (kept) {
      report.loaded = true;
    } else {
      // Its session's project, for the page to go when the project does (a project's sessions go with no word of their own).
      if (page.session) page.project = (await sessionProject(page.session)) ?? null;
      await bindExtensionSurface({
        webContentsId: contents.id,
        extensionId: installed.manifest.id,
        tabId: `extension-check:${contents.id}`,
        tabKind: `${installed.manifest.id}.${tab.name}`,
        ...(request.chatId ? { chatId: request.chatId } : {}),
        ...(request.itemId ? { itemId: request.itemId } : {}),
        // F94 A tab of the caller's session: for a file of its working copy, or the App's own page (owner 10-13).
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        ...(request.filePath ? { filePath: request.filePath } : {}),
        operator: request.operator,
      });
      const entry = tab.entry ?? installed.manifest.entry;
      if (!entry) throw new Error('This App tab has no HTML entry');
      const url = extensionResourceUrl(installed.manifest.id, entry);
      const load = page.win.loadURL(url).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );
      const failure = await Promise.race([load, delay(Math.max(0, deadline - Date.now())).then(() => 'timed out' as const)]);
      if (failure === 'timed out') {
        report.loadError = `the page did not finish loading within ${request.timeoutMs} ms`;
        report.stuck = 'load';
      } else if (failure !== null) {
        report.loadError = page.crash ?? `the page failed to load: ${failure}`;
      } else {
        report.loaded = true;
      }
    }
    if (report.loaded) {
      // Frames from here on, as on screen (#7126): what it draws by frames settles before it is read and pictured.
      try {
        await byDeadline(keepPainting(contents), Date.now() + EXTENSION_STEP_WAIT_MS, SILENT);
      } catch (error) {
        if (!heard(error)) {
          const message = `gugu could not keep the hidden page drawing, so what moves by frames may be pictured at its start: ${error instanceof Error ? error.message : String(error)}`;
          (report.host ??= []).push({ level: 'error', message });
          log.warn('app_check could not keep the page painting', { extensionId: request.extensionId, message });
        }
      }
    }
    // Loaded or not, what it shows by now is worth reading: let it settle — its files opened, then quiet — and read.
    let shown = '';
    /** Until the page settled or `until`: what it was still waiting on then; null once it settled (or went away). */
    const settle = async (until: number): Promise<ExtensionCheckStep | null> => {
      while (!contents.isDestroyed() && page.crash === null) {
        if (silent) return 'quiet';
        const now = await byDeadline(readText(contents), Math.max(until, Date.now() + READ_MIN_MS), SILENT).catch(heard);
        if (typeof now !== 'string') return 'quiet';
        if (now !== shown) {
          shown = now;
          changed();
        }
        // Its runtime counts the `files.open(…)` calls it made and those resolved or rejected (L3 2ef12b2e5).
        const readings = checkReadingsOf(contents.id);
        const pending = (readings?.opens ?? 0) > (readings?.opensSettled ?? 0);
        if (pending) changed();
        if (Date.now() - page.lastChange >= QUIET_MS) return null;
        if (Date.now() >= until) return pending ? 'files.open' : 'quiet';
        await delay(POLL_MS);
      }
      return null;
    };
    // A page gone on with settled before: it is where the last call left it.
    if (!kept && !report.stuck) {
      const stuck = await settle(deadline);
      if (stuck) report.stuck = stuck;
    }
    if (report.loaded && !contents.isDestroyed() && page.crash === null) {
      const debug = contents.debugger;
      const cdp: StepHost['cdp'] = async (method, params) => {
        if (!debug.isAttached()) debug.attach('1.3');
        return debug.sendCommand(method, params);
      };
      const evaluate = (code: string) => contents.executeJavaScript(code, true);
      // A step changed the page: it settles as the page did after its load, for at most `ms` — and says if it still answers.
      const settleFor = async (ms: number) => {
        changed();
        await settle(Date.now() + ms);
        return !silent;
      };
      const { size } = page;
      // Each read below gets its own wait at most, as a step does: the window is destroyed (finally) whatever the page does.
      const pictureAtSize = async (label: string): Promise<ExtensionPicture | null> => {
        if (silent) return null;
        const take = async () => {
          const picture = await pictureOf(contents, size, `${label}, ${size.says}`);
          await showAtSize(contents, size);
          return picture;
        };
        try {
          return await byDeadline(take(), Date.now() + EXTENSION_STEP_WAIT_MS, SILENT);
        } catch (error) {
          if (!heard(error)) log.warn('app_check could not take a picture of a step', { extensionId: request.extensionId, message: error instanceof Error ? error.message : String(error) });
          return null;
        }
      };
      try {
        let ran: Awaited<ReturnType<typeof runSteps>> | null = null;
        if (request.steps?.length) {
          if (silent) throw new Error(SILENT);
          await byDeadline(showAtSize(contents, size), Date.now() + EXTENSION_STEP_WAIT_MS, SILENT);
          await settleFor(1_000);
          ran = await runSteps(request.steps, {
            cdp,
            evaluate,
            settle: settleFor,
            said: () => ({ errors: [...report.errors], console: [...report.console], readings: checkReadingsOf(contents.id) }),
            picture: pictureAtSize,
            touch: size.touch,
            deadline: Date.now() + EXTENSION_STEPS_TIMEOUT_MS,
          });
          report.steps = ran.results;
        }
        // What it shows, as its accessibility tree outlines it — what a step names (it replaced the text, owner 10-12).
        try {
          const read = async () => ariaSnapshot((await readTree({ cdp })).nodes);
          if (!silent) report.snapshot = await byDeadline(read(), Date.now() + EXTENSION_STEP_WAIT_MS, SILENT);
        } catch (error) {
          if (heard(error)) throw error;
          const message = `gugu could not read the page's accessibility tree: ${error instanceof Error ? error.message : String(error)}`;
          (report.host ??= []).push({ level: 'error', message });
          log.warn('app_check could not read the page snapshot', { extensionId: request.extensionId, message });
        }
        // What it looks like, for the agent to look at before it says the App is done: where the steps left it, or where
        // a page gone on with is now; a new page where it opens, light and dark — and on a phone too, if it goes there.
        if (ran || kept) {
          const end = await pictureAtSize(ran ? 'the end, after the steps' : 'as it is now');
          report.pictures = [...(ran?.pictures ?? []), ...(end ? [end] : [])];
        } else if (!silent) {
          const sizes = opensInChats(installed.manifest) && !size.touch ? [size, PHONE] : [size];
          const each = () => picturesOf(contents, sizes, (theme) => showAgentPageInTheme(contents.id, theme));
          report.pictures = await byDeadline(each(), Date.now() + 2 * sizes.length * EXTENSION_STEP_WAIT_MS, SILENT);
        }
      } catch (error) {
        // The host's failure, never the page's (gugu.js and the look are put in every App page): ours to read, not the agent's.
        if (!heard(error)) log.warn('app_check could not take pictures of the page', { extensionId: request.extensionId, message: error instanceof Error ? error.message : String(error) });
        // Steps asked for and never reached (the page stopped answering before them) are said so: never a silent ok.
        report.steps ??= request.steps?.map((_, index) => ({ step: index + 1, ok: null, error: 'not run: the page stopped answering' }));
      } finally {
        endPictures(contents);
      }
    }
    // A page that stopped answering never settled, whatever it did before: never ok.
    if (silent) report.stuck ??= 'quiet';
    if (!contents.isDestroyed() && page.crash === null) {
      // The last counts arrive at most 250 ms after the page did something: read them before the page goes.
      await delay(COUNTS_LAG_MS);
      const readings = checkReadingsOf(contents.id);
      const fresh = readingsSince(page.readings, readings);
      if (fresh) report.readings = fresh;
      page.readings = readings;
    }
    if (page.crash !== null) {
      report.loaded = false;
      report.loadError = page.crash;
    }
  } catch (error) {
    report.loadError ??= error instanceof Error ? error.message : String(error);
    log.warn('app_check could not run the page', { extensionId: request.extensionId, message: report.loadError });
  } finally {
    // Closed or loaded again under this very check (review 9107b50e04): what it read is not the page it asked about.
    const gone = page.closed ?? (page.reloaded ? 'loaded again (its App installed again, switched off or granted otherwise)' : null);
    if (gone) {
      report.loaded = false;
      report.loadError = `the page was ${gone} while this check ran`;
    }
    // Kept for its session to go on with while it works; a page that failed, stopped answering or was reloaded under it
    // (its App installed again, switched off) is closed — what it held is gone or wrong.
    if (page.session !== null && report.loaded && !silent && page.crash === null && !contents.isDestroyed()) {
      page.usedAt = Date.now();
      page.idle = setTimeout(() => closePage(page), EXTENSION_CHECK_PAGE_IDLE_MS);
      page.report = emptyReport();
      report.page = page.id;
      // Others that waited out a check of their own over the limits go now — never this one, which its answer names.
      makeRoom(0, page.session);
      page.busy = false;
    } else {
      page.busy = false;
      closePage(page);
    }
  }
  report.pages = pageRecordsSinceInstall(installed.manifest.id, installed.rootDir);
  // 摩擦单 F77 Its tools for agents, as its programs list them now: one that does not start (a tools module that is not all
  // tools names the export) is the App failing, said here rather than found by an agent calling it.
  const programs = extensionPrograms.installed().filter((program) => program.extensionId === installed.manifest.id);
  const listed: { program: (typeof programs)[number]; tools: Awaited<ReturnType<typeof extensionPrograms.tools>> }[] = [];
  for (const program of programs) {
    try {
      listed.push({ program, tools: await extensionPrograms.tools(program) });
    } catch (error) {
      report.errors.push({ kind: 'program', level: 'error', message: `program ${program.server}: ${programFailureReason(program, error)}` });
    }
  }
  // F119 The names agents call (`<App id>__<tool>`), as the catalog gives them; a name two programs give fails the check.
  const { tools, clashes } = agentToolsOf(listed);
  if (programs.length > 0) report.tools = tools.map((tool) => tool.name);
  report.errors.push(...clashes.map(({ why }) => ({ kind: 'program' as const, level: 'error' as const, message: why })));
  // A skill whose SKILL.md cannot be read reaches no session: the App failing, said here (skill 注入核查 10-14 — the install
  // and the check said nothing, the catalog left it out silently, and the agent took the nearest other skill instead).
  const skills = installed.manifest.contributes.skills;
  if (skills) {
    readExtensionSkills(installed.manifest.id, path.join(installed.rootDir, skills), (message) =>
      report.errors.push({ kind: 'skill', level: 'error', message }));
  }
  // F96 What the bundle's scripts say that cannot work, read rather than run: hints, with the line.
  report.errors.push(...staticHints(installed.rootDir).map((hint) => ({ kind: 'static' as const, level: 'hint' as const, ...hint })));
  report.elapsedMs = Date.now() - started;
  return report;
}

/**
 * A check's page kept for the session that opened it (`page`, owner 10-13: 「连续地操作一个页面…而不是每次从头执行」):
 * what it holds in memory — a selection, a scroll, an open dialog — is there for the next call. One is ~108 MB (mac1 10-13,
 * two Apps). Closed when unused for EXTENSION_CHECK_PAGE_IDLE_MS, when its session or the machine opens one past
 * EXTENSION_CHECK_PAGES_PER_SESSION / _PER_MACHINE (`makeRoom`), when its session or project ends or its App is removed
 * (`closeCheckPages`), and when it is reloaded under it. No call closes one: these bound it (owner 10-13, no close).
 */
interface CheckPage {
  readonly id: string;
  /** The session that opened it, the only one that may go on with it; null: a caller in no session, closed after its call. */
  readonly session: string | null;
  /** That session's project: deleting it says only the project's id. */
  project: string | null;
  /** Why it was closed while a check of it ran — that check says so. */
  closed: string | null;
  readonly extensionId: string;
  readonly tabName: string;
  readonly win: BrowserWindow;
  /** Where it is shown, fixed when it opened: its steps and pictures are at this width and touch. */
  readonly size: PictureSize;
  /** The call running now: what the page says goes into its report. */
  report: ExtensionCheckReport;
  lastChange: number;
  crash: string | null;
  /** What it had done when its last call ended: a call reports only what it did since. */
  readings: CheckReadings | null;
  busy: boolean;
  /** Loaded again under it (its App installed again, switched off, granted otherwise): what it held is gone. */
  reloaded: boolean;
  usedAt: number;
  idle: ReturnType<typeof setTimeout> | null;
}
const checkPages = new Map<string, CheckPage>();

/** `why`: what closed it, said by a check of it running now. */
function closePage(page: CheckPage, why?: string): void {
  checkPages.delete(page.id);
  if (page.idle) clearTimeout(page.idle);
  if (page.busy && why) page.closed = `closed (${why})`;
  // Closing it unbinds it (the bridge's `destroyed` hook): nothing of it stays.
  if (!page.win.isDestroyed()) page.win.destroy();
}

/** Its session ended (deleted, archived, its project deleted) or its App was removed: the kept pages go with it. */
export function closeCheckPages(of: { sessionId: string } | { projectId: string } | { extensionId: string }): void {
  for (const page of [...checkPages.values()]) {
    if ('sessionId' in of && page.session === of.sessionId) closePage(page, 'its session ended');
    if ('projectId' in of && page.project === of.projectId) closePage(page, 'its project was deleted');
    if ('extensionId' in of && page.extensionId === of.extensionId) closePage(page, 'its App was removed');
  }
}

/**
 * Room for `more` pages within the limits — the session's, the machine's: their least recently used go, never one in a
 * check (review 9107b50e04: a page gone on with is the least recently used until its check ends). All in checks: over
 * the limit for now, trimmed when one of them ends.
 */
function makeRoom(more: 0 | 1, session: string | null): void {
  const over = (pages: CheckPage[], limit: number) =>
    pages.filter((page) => !page.busy).sort((a, b) => a.usedAt - b.usedAt).slice(0, Math.max(0, pages.length + more - limit));
  if (session) for (const page of over([...checkPages.values()].filter((page) => page.session === session), EXTENSION_CHECK_PAGES_PER_SESSION)) closePage(page);
  for (const page of over([...checkPages.values()], EXTENSION_CHECK_PAGES_PER_MACHINE)) closePage(page);
}

/** The project a session is in, as its agent's context says; null when it cannot be read (the page then waits out its idle). */
async function sessionProject(sessionId: string): Promise<string | null> {
  try {
    const { agentSessionContext } = await import('@main/core/extensions/extension-agent-context');
    return (await agentSessionContext(sessionId))?.projectId ?? null;
  } catch {
    return null;
  }
}

/** The page `id` for this caller to go on with: another session's is not found, exactly as a closed one is. */
function keptPage(id: string, request: ExtensionCheckRequest): CheckPage {
  const page = checkPages.get(id);
  if (!page || page.session === null || page.session !== request.caller || page.win.isDestroyed()) {
    throw new Error(
      `app_check: page "${id}" is not found. A page closes ${EXTENSION_CHECK_PAGE_IDLE_MS / 60_000} min after its last check, when ` +
        `its session opens more than ${EXTENSION_CHECK_PAGES_PER_SESSION} or the machine more than ${EXTENSION_CHECK_PAGES_PER_MACHINE}, ` +
        'when its App is installed again or removed, and when its session or its project ends; only the session that opened it ' +
        'goes on with it. Check without page to open a new one.'
    );
  }
  const kind = `${page.extensionId}.${page.tabName}`;
  if (kind !== `${request.extensionId}.${request.tabName}`) throw new Error(`app_check: page "${id}" is a page of ${kind}`);
  if (page.busy) throw new Error(`app_check: page "${id}" is in a check now — go on once its answer is back`);
  return page;
}

/** A new hidden page for `request`, where it opens; past the limits, the least recently used not in a check go first. */
function openPage(request: ExtensionCheckRequest): CheckPage {
  const service = extensionsService();
  const installed = service.get(request.extensionId);
  const preload = resolveExtensionBridgePreload(__dirname);
  if (!preload) throw new Error('app_check: the App bridge is missing from this build');
  makeRoom(1, request.caller ?? null);
  // Hardened before the page asks for anything, as for a tab (controller `activate`).
  configureExtensionSession({
    extensionId: installed.manifest.id,
    rootDir: installed.rootDir,
    networkHosts: service.grantedHosts(installed.manifest.id),
  });
  // Where it opens (owner 10-13): a group's panel, a phone, or a tab of the session as wide as it is shown there now.
  const size = request.phone
    ? PHONE
    : request.chatId
      ? GROUP_PANEL
      : taskPane(request.sessionId ? shownTabWidth(installed.manifest.id, request.tabName, request.sessionId) : null);

  const win = new BrowserWindow({
    show: false,
    // As big as where it opens: its pictures fit, and between checks — the emulated size goes with the debugger — it
    // stays laid out as it was.
    width: size.width,
    height: PICTURE_MAX_HEIGHT,
    useContentSize: true,
    webPreferences: {
      partition: extensionPartition(installed.manifest.id),
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      // Hidden, yet it has to run as it would on screen: timers, the open file, its first paint.
      backgroundThrottling: false,
      // The check's page (F69): the preload has the runtime report its counts — the check waits for its opens (F5).
      additionalArguments: [CHECK_PAGE_ARG],
    },
  });
  const contents = win.webContents;
  let id: string;
  do id = `p-${randomBytes(3).toString('hex')}`;
  while (checkPages.has(id));
  const page: CheckPage = {
    id,
    session: request.caller ?? null,
    project: null,
    closed: null,
    extensionId: installed.manifest.id,
    tabName: request.tabName,
    win,
    size,
    report: emptyReport(),
    lastChange: Date.now(),
    crash: null,
    readings: null,
    busy: false,
    reloaded: false,
    usedAt: Date.now(),
    idle: null,
  };
  checkPages.set(id, page);
  const changed = () => {
    page.lastChange = Date.now();
  };
  // Its first load, then any other: loaded again under it (reloadExtensionSurfaces), it is not the page it was.
  let loads = 0;
  contents.on('did-finish-load', () => {
    if (++loads < 2) return;
    page.reloaded = true;
    if (!page.busy) closePage(page);
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (isAllowedExtensionNavigation(url, installed.manifest.id)) return;
    event.preventDefault();
    // Said to the check, as a real page's author hears it (统筹 06:52): the page stays on its own origin.
    reportBlockedNavigation(contents.id, url);
  });
  contents.on('console-message', (event) => {
    const { level, message, sourceId, lineNumber } = event;
    // Electron's own scripts (its sandbox bootstrap, its preload runner): what they say is the host failing to start the
    // page, not the App — said to the agent apart, and to gugu's log (#7126).
    if (sourceId.startsWith(ELECTRON_SCRIPT_PREFIX)) {
      if (level !== 'error' && level !== 'warning') return;
      (page.report.host ??= []).push({ level, message: `${message} (${sourceId}:${lineNumber})` });
      log.warn('app_check: Electron failed while it started the page', { extensionId: request.extensionId, level, message, sourceId });
      return;
    }
    const where = sourceLine(installed.manifest.id, installed.rootDir, sourceId, lineNumber);
    const source = where?.source ?? (sourceId ? `${sourceId}:${lineNumber}` : undefined);
    const at = { ...(source ? { source } : {}), ...(where?.line !== undefined ? { line: where.line } : {}) };
    // Chromium prints what the page threw as a console error: "Uncaught …" / "Uncaught (in promise) …".
    if (level === 'error' && message.startsWith('Uncaught (in promise)')) {
      page.report.errors.push({ kind: 'unhandledrejection', level: 'error', message, ...at });
    } else if (level === 'error' && message.startsWith('Uncaught')) {
      page.report.errors.push({ kind: 'uncaught', level: 'error', message, ...at });
    } else if (level === 'error' || level === 'warning') {
      page.report.console.push({ level, message: source ? `${message} (${source})` : message });
    } else {
      return;
    }
    changed();
  });
  contents.on('render-process-gone', (_event, details) => {
    page.crash = `the page crashed (${details.reason})`;
  });
  const stopWatching = watchExtensionSurfaceErrors(contents.id, (message, level) => {
    page.report.errors.push({ kind: 'reportError', level, message });
    changed();
  });
  contents.once('destroyed', stopWatching);
  return page;
}

function emptyReport(): ExtensionCheckReport {
  return { loaded: false, loadError: null, errors: [], console: [], snapshot: '', pages: [], elapsedMs: 0 };
}

/** What a page did since `before` (a call on a page gone on with says only what is new); null: nothing. */
function readingsSince(before: CheckReadings | null, now: CheckReadings | null): CheckReadings | null {
  if (!now || !before) return now;
  const fresh: CheckReadings = {
    ...now,
    writes: now.writes - before.writes,
    presenceSets: now.presenceSets - before.presenceSets,
    opens: now.opens - before.opens,
    opensSettled: now.opensSettled - before.opensSettled,
    shown: now.shown.slice(before.shown.length),
  };
  return fresh.writes || fresh.presenceSets || fresh.opens || fresh.shown.length ? fresh : null;
}

/**
 * F68 What the App's real pages recorded since this version was installed — its bundle's manifest.json is written at
 * install, so a hint an older version earned is not pinned on this one. The check's own page is not among them.
 */
function pageRecordsSinceInstall(extensionId: string, rootDir: string): ExtensionCheckReport['pages'] {
  let installedAt = 0;
  try {
    installedAt = fs.statSync(path.join(rootDir, 'manifest.json')).mtimeMs;
  } catch {
    // No stat: every record there is.
  }
  return recentExtensionErrors(extensionId)
    .filter((record) => Date.parse(record.at) >= installedAt)
    .map(({ at, level, message, page }) => ({
      at,
      level,
      message,
      page: { tabKind: page.tabKind, chatId: page.chatId, itemId: page.itemId, sessionId: page.sessionId },
    }));
}

async function readText(contents: Electron.WebContents): Promise<string> {
  try {
    const text: unknown = await contents.executeJavaScript('document.body ? document.body.innerText : ""', false);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
