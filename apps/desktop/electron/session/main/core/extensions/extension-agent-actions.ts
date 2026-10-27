import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import {
  declaredPermissions,
  scaffoldExtension,
  AgentPermissionRefusal,
} from '@main/core/extensions/extension-authoring';
import {
  claimedSuffixes,
  declaredContexts,
  EXTENSION_API_VERSION,
  extensionTabKind,
  opensFilesSchema,
  parseExtensionTabKind,
  programLine,
  type ExtensionMcpServerContribution,
  type ExtensionManifest,
} from '@shared/extensions/manifest';
import type { CloudMarketEntry } from '@shared/extensions/market';
import { APP_RUNTIME_GLUE_MODULE } from '@shared/extensions/app-runtime-protocol';
import { extensionsService } from '@main/core/extensions/extensions-root';
import { installPlan } from './install-plan';
import { windowNoteOf, requestExtensionInstallConsent } from './extension-bridge-relay';
import type { ExtensionInstallConsentRequest, ExtensionInstallConsentResult } from '@shared/extensions/host-actions';
import { installExtensionFromAttachment } from './extension-attachment-install';
import { dropReceivedPackage, readReceivedPackage, receivePackagePart } from './received-packages';
import { installExtensionFromMarket } from './extension-market-install';
import { createAppFork, prepareForkVariant } from './app-forks';
import { prepareVariant, switchExtensionVariant } from './extension-variants';
import { installPrepared } from './install-prepared';
import { resolvesInside } from './path-containment';
import { readExtensionSkills } from '../../../../extension-session-mcp';
import { EXTENSION_ARCHIVE_MIME, EXTENSION_ARCHIVE_SUFFIX, packExtensionArchive, packInstalledExtension, unpackExtensionArchive } from './extension-archive';
import type { CloudExtensionMarket, CloudMarketListing } from './market-catalog';
import { APP_CHECK_ARGS, APP_CREATE_ARGS, APP_INSTALL_ARGS, APP_PACK_ARGS, manifestFragmentSchema } from '@shared/extensions/app-tool-args';
import { handedConsentSchema, type HandedConsent } from '@shared/extensions/install-consent-flow';
import { TEMPLATE_AUTHOR_FILES, TEMPLATE_LOOK, extensionTemplate, templateFileSuffix } from './extension-templates';
import {
  EXTENSION_CHECK_PAGE_IDLE_MS,
  EXTENSION_CHECK_TIMEOUT_MS,
  EXTENSION_STEP_KEYS,
  isExtensionStepKey,
  type ExtensionCheckReport,
  type ExtensionCheckRequest,
} from '@shared/extensions/extension-check';

/**
 * Dispatches what `gugu_session`'s app_* actions asked for.
 *
 * Lives on the session-main side because that is where the extensions root and its
 * service live; the host reaches it through the same bridge module it already
 * uses for everything else in this directory, rather than pulling the session-page
 * module graph into the host bundle.
 *
 * Arguments are parsed here too, not only in the tool: the tool face is one caller of this, not the only one
 * (the host builds some of these actions itself). The agent's own arguments are one description, shared with
 * the tool face (`@shared/extensions/app-tool-args`), so what an agent is shown is what is enforced. The tool face names them `app_create`
 * and so on; the prefix is stripped in gugu-session-tool.ts, so the names here stay bare —
 * ❌ 别让两边各写一份动作名清单。Refs #2374.
 */

const agentActionSchema = z.discriminatedUnion('action', [
  // 入参与 agent 看到的那张是同一份(app-tool-args.ts,App 体检 10-17 #15)。
  // opens_files 与 manifest 在这一侧真判(工具那一面原样放行,见 app-tool-args.ts 顶上)。
  z.object({ action: z.literal('create'), ...APP_CREATE_ARGS, opens_files: opensFilesSchema.optional(), manifest: manifestFragmentSchema.optional() }),
  z.object({ action: z.literal('pack'), ...APP_PACK_ARGS }),
  // 摩擦单 F107 Built by the host (acp-engine-utils) when the group already holds this version's card with other bytes.
  z.object({ action: z.literal('bump'), source_dir: z.string().min(1) }),
  z.object({ action: z.literal('install'), ...APP_INSTALL_ARGS }),
  // #6646 Built by the host from `app_install { source_message_id }` after it read the message as this agent: the card's
  // message (#7290), which the install reads as the owner — who published it is the server's word on it, never a URL.
  z.object({
    action: z.literal('install_attachment'),
    message_id: z.string().min(1),
    // D-31 Another machine of the owner's asked the person (app_install { device }): what to do with that ask here.
    consent: handedConsentSchema.optional(),
  }),
  // #7290 Built by the host for `app_install { device, source_dir }`: the owner's own folder, packed on their other machine
  // and installed here as a folder is (origin 'folder', the person signed in here its publisher). Its bytes came over the
  // device channel from `from_device` (`receive_package_part`); `digest` is the package's sha256 that machine packed —
  // bytes that are not those are refused.
  z.object({
    action: z.literal('install_folder_package'),
    from_device: z.string().min(1),
    upload_id: z.string().min(1),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    chat_id: z.string().min(1).optional(),
    consent: handedConsentSchema.optional(),
  }),
  // #7290 Built by the host: one part of that package, as `from_device` sent it (in order, base64; the same parts a remote save uses).
  z.object({
    action: z.literal('receive_package_part'),
    from_device: z.string().min(1),
    upload_id: z.string().min(1),
    offset: z.number().int().min(0),
    total: z.number().int().min(1),
    final: z.boolean(),
    data: z.string(),
  }),
  // Built by the host for `app_install { market, chat_id }`: the installed copy, packed for the chat's card (no folder of the agent's has it).
  z.object({ action: z.literal('pack_installed'), id: z.string().min(1) }),
  // D-31 Built by the host for `app_install { device }`: the other machine handed back its ask, asked here as this agent's.
  z.object({ action: z.literal('ask_install'), request: z.custom<ExtensionInstallConsentRequest>((value) => typeof value === 'object' && value !== null) }),
  z.object({ action: z.literal('check'), ...APP_CHECK_ARGS }),
]);

/**
 * #6387 An agent that installs an extension bringing tools and skills is in a session started
 * before it. Say what reaches it, or the agent guesses (real run: it listed two theories and asked).
 *
 * #6615 问题 11: the tools DO reach this session — through the catalog, read live (D-10). The earlier
 * sentence「this session does not have them」predates the catalog; W-21 measured a Codex agent believing it,
 * spawning a throwaway session to test its own tool and telling the person only new sessions could use it.
 * Skills still reach only sessions that start later (they are handed over at session start).
 *
 * D-30: only an agent its owner gave the App to has any of that. A-B 10-06 C4c: the person took the installing agent's
 * group out on the sheet, and the answer still said the tools were in its catalog — the catalog said not given.
 */
function forAgentsNote(manifest: {
  id: string;
  contributes: { mcpServers?: readonly unknown[]; skills?: string };
}, listed: boolean, given: boolean): { for_agents?: string } {
  const servers = manifest.contributes.mcpServers ?? [];
  if (servers.length === 0 && !manifest.contributes.skills) return {};
  if (!given) {
    return {
      for_agents:
        "Its owner did not give it to you: they choose which agents get an App's tools and skills (its row in 「App」), " +
        'so you do not have them.',
    };
  }
  const parts: string[] = [];
  if (servers.length > 0) {
    // #6634 问题 16: nothing has asked its programs for their tools yet, so this does not promise they are there —
    // the catalog asks on first use, and a program it has to leave out is named, with why, when a tool is not found.
    parts.push(
      `Its tools reach the catalog in this session too: catalog_list with name "${manifest.id}" shows the ones its ` +
        'programs list, and catalog_call runs one; asking for a tool that is not there says which program was left ' +
        // What the install left, not what the manifest asked (D-28: toolsListed counts at a first install only).
        `out and why. ${listed
          ? 'From the next session on they are listed natively (the person can switch that back).'
          : 'From the next session on the person can have them listed natively instead.'} They run on the ` +
        'computers it is installed on: another person\'s agent has them once its owner installs the card too.'
    );
  }
  if (manifest.contributes.skills) {
    parts.push(`Its skills are in the catalog too, next to its tools: catalog_list with name "${manifest.id}" shows each one and the SKILL.md to read.`);
  }
  return { for_agents: parts.join(' ') };
}

/** Asked after the install recorded where it was given; a caller without a session (no owner choosing for it) has every App. */
const callerHasApp = async (dependencies: ExtensionAgentActionDependencies, extensionId: string) =>
  dependencies.callerHasApp ? dependencies.callerHasApp(extensionId) : true;

/** What the agent still has to write before installing: the files the declared programs run, when none is there yet. */
function programFilesNote(servers: readonly ExtensionMcpServerContribution[] | undefined, sourceDir: string): string {
  const named = (server: ExtensionMcpServerContribution) =>
    'host' in server ? [] : 'tools' in server ? [server.tools] : [server.command.replace(/^\.\//, ''), ...(server.args ?? [])];
  const missing = (servers ?? []).filter((server) => !('host' in server) && !named(server).some((file) => fs.existsSync(path.join(sourceDir, file))));
  if (!missing.length) return '';
  return `Write the files its programs run (${missing.map(programLine).join('; ')}) into source_dir before installing. `;
}

function skillsNote(skills: string | undefined): string {
  return skills ? `Put each skill at ${skills}/<skill>/SKILL.md in source_dir. ` : '';
}

/**
 * The skills of the installed bundle no session will get, each as its reader said it (skill 注入核查 10-14: a SKILL.md
 * whose frontmatter did not parse was left out, and app_install said nothing — only the main log did, naming no App).
 */
function skillsLeftOut(installed: { manifest: ExtensionManifest; rootDir: string }): string[] {
  const skills = installed.manifest.contributes.skills;
  const leftOut: string[] = [];
  if (skills) readExtensionSkills(installed.manifest.id, path.join(installed.rootDir, skills), (message) => leftOut.push(message));
  return leftOut;
}

/**
 * F11 What is left to do on a group-json App, in order, with the exact calls: the agent's part of app.js, the App
 * installed and sent to the chat in one call (F15 — the others do not have it otherwise), a data file for the chat,
 * a check that it runs (F14 signature), and telling the chat.
 *
 * L5 S1 rerun: 29 calls where 6 do — four of them reading the template back, then app.js, main.html and style.css
 * rewritten whole. So the answer carries app.js (app_js) and says what to leave alone.
 */
const chatSuffixOf = (claims: z.infer<typeof opensFilesSchema> | undefined): string | undefined =>
  claims && !Array.isArray(claims) ? claims.chat?.[0] : undefined;

function groupJsonNote(suffix: string, sourceDir: string, ownAppJs: boolean): string {
  const dir = JSON.stringify(sourceDir);
  // F40 The whole rest is one call: install here, the chat's data file, a check on it, the card — then one message.
  const install =
    `app_install {"source_dir":${dir},"chat_id":"<the chat>","data":{"title":"<what the chat calls it>",` +
    `"content":<what it starts with, as JSON>}} (or "data":{"item_id":"…"}: one in the chat) — installs it on ` +
    `your owner's computer, checks the App on that data file, and sends the card when the check is ok; then tell the chat, with the ` +
    'link it gives back. On a fix: install again with the same chat_id and data — the data file is kept.';
  if (ownAppJs) return `The ${suffix} files of a chat open in it; your app.js is in place. Next: ${install} `;
  return (
    `The ${suffix} files of a chat open in it. app_js is app.js as written — edit its functions, do not rewrite the ` +
    'file: renderShared() draws the file\'s data into #shared on every change; setup() draws what a person fills in ' +
    '(inputs, a Submit button) into #controls once, never rebuilt on a change — rebuilding it wipes what they are typing. ' +
    `No need to read main.html or style.css; ${APP_RUNTIME_GLUE_MODULE} is gugu's (it opens the file and shows offline and errors); ` +
    `${TEMPLATE_LOOK}. ` +
    `(Next time pass app.js in this same call, as files {"app.js": "…"}, and skip this edit.) Then: ${install} `
  );
}

type CreateAction = Extract<z.infer<typeof agentActionSchema>, { action: 'create' }>;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * F72 / F93 One way to put a manifest together: a base — the template's, or the bundle already in the folder — with
 * what this call says laid over it key by key, as an object assigned in f.data merges (F43). Objects merge; a tab merges
 * into the base's tab of the same name, and a new name is a new tab; `opensFiles` is replaced whole — what this call
 * says a tab opens is what it opens (摩擦单 F114); any other value this call gives replaces the base's. Nothing here
 * refuses: a manifest that comes out wrong is refused by the manifest's own schema, naming the field.
 */
function overlay(base: unknown, over: unknown, key?: string): unknown {
  if (over === undefined) return base;
  if (key === 'opensFiles') return over;
  if (key === 'tabs' && Array.isArray(base) && Array.isArray(over)) {
    const tabs = base.map((tab) => ({ ...(tab as Json) }));
    for (const tab of over as Json[]) {
      const at = tabs.findIndex((mine) => mine.name === tab?.name);
      if (at === -1) tabs.push(tab);
      else tabs[at] = overlay(tabs[at], tab) as Json;
    }
    return tabs;
  }
  if (isObject(base) && isObject(over)) {
    const merged: Json = { ...base };
    for (const [name, value] of Object.entries(over)) merged[name] = overlay(base[name], value, name);
    return merged;
  }
  return over;
}

/**
 * S1 What `create` writes: one manifest.json and the files, pages among them. F72 A template and the agent's own
 * `manifest` (tabs included) are one manifest: the template's is the base and the agent's lies over it. F93 A folder
 * that already holds this App is the base instead: the same call updates it in place. A tab's page is `<name>.html`
 * unless its entry names another, so each tab has its own (a manifest would fall back to the first tab's page).
 */
function bundleOf(
  action: CreateAction,
  existing: Json | null
): { manifest: Json; files: Record<string, string>; templateFiles: Record<string, string> } {
  if (!action.id || !action.name) throw new Error('app_create: give id and name for a new App, or fork_of to fork an installed App');
  const own = action.manifest ?? {};
  for (const key of ['id', 'name', 'version'] as const) {
    if (own[key] !== undefined) throw new Error(`app_create: ${key} is its own parameter, not a field of manifest`);
  }
  const ownTabs = own.contributes?.tabs;
  if (!existing && action.template === undefined && ownTabs === undefined && !own.contributes?.mcpServers && !own.contributes?.skills) {
    throw new Error('app_create: give a template (a ready-made App) or your own tabs in manifest.contributes.tabs, or both');
  }
  // The one real contradiction: the first tab's claim said twice in one call, differently.
  const firstClaims = ownTabs?.[0]?.opensFiles;
  if (action.opens_files && firstClaims !== undefined && JSON.stringify(firstClaims) !== JSON.stringify(action.opens_files)) {
    throw new Error(
      `app_create: opens_files says ${JSON.stringify(action.opens_files)} and manifest.contributes.tabs[0].opensFiles ` +
        `says ${JSON.stringify(firstClaims)} — say it once`
    );
  }
  const template = action.template ? extensionTemplate(action.template, { id: action.id, name: action.name }) : null;
  // A template's page given again in files (125 10-06, R's A/B: main.html + main.js of its own laid over the template's,
  // its app.js left loaded by nothing — then 7 approvals of Read / Write / rm to tidy up). Refused, saying where the code
  // goes: never two Apps in one folder, and never one quietly thrown away.
  const taken = template ? Object.keys(action.files ?? {}).filter((name) => name in template.files && !TEMPLATE_AUTHOR_FILES.includes(name)) : [];
  if (taken.length > 0) {
    throw new Error(`app_create: template "${action.template}" writes ${taken.join(', ')}; put your code in files["app.js"], or leave out template`);
  }
  let manifest = overlay(existing ?? {}, template ? { platforms: template.platforms, contributes: { tabs: template.tabs } } : {}) as Json;
  manifest = overlay(manifest, own) as Json;
  const contributes = (manifest.contributes ?? {}) as Json;
  const tabs = ((contributes.tabs ?? []) as Json[]).map((tab) => tab.hostPage ? tab : ({ entry: `${String(tab.name)}.html`, ...tab }));
  // 摩擦单 F114 (S23: {"session":["TODO.md"]} on group-json also kept the template's group claim) It is the claim, whole.
  if (action.opens_files && tabs[0]) tabs[0] = overlay(tabs[0], { opensFiles: action.opens_files }) as Json & { entry: string };
  return {
    manifest: {
      // A new App's; one being changed keeps its own, and an older one is refused with what to change.
      apiVersion: EXTENSION_API_VERSION,
      ...(tabs[0]?.entry ? { entry: tabs[0].entry } : {}),
      ...manifest,
      id: action.id,
      name: action.name,
      version: action.version ?? (existing?.version as string | undefined) ?? '0.1.0',
      contributes: { ...contributes, ...(tabs.length ? { tabs } : {}) },
    },
    files: { ...action.files },
    templateFiles: { ...template?.files },
  };
}

/**
 * F93 (S23: "already contains an extension bundle", and the agent made a second folder) The App already in the folder,
 * as its manifest.json says — the base an update lies over. Another App there is refused, saying what to do.
 */
function bundleThere(sourceDir: string, id: string): Json | null {
  const file = path.join(sourceDir, 'manifest.json');
  if (!fs.existsSync(file)) return null;
  let there: unknown;
  try {
    there = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`app_create: ${file} is not JSON (${error instanceof Error ? error.message : String(error)}); fix it, or give another target_dir`);
  }
  const thereId = isObject(there) ? there.id : undefined;
  if (thereId !== id) {
    throw new Error(
      `app_create: ${sourceDir} holds the App ${JSON.stringify(thereId)}. To change that App, call app_create with id ` +
        `${JSON.stringify(thereId)} — the folder is updated in place; for a new App, give another target_dir.`
    );
  }
  return there as Json;
}

export interface ExtensionAgentActionDependencies {
  requestInstallConsent?: (request: ExtensionInstallConsentRequest) => Promise<ExtensionInstallConsentResult>;
  /** 与上面同因可注入:装完那声「喊」要走真宿主窗口,单测里没有窗口。 */
  notifyInstalledChanged?: () => Promise<void>;
  /**
   * #6264 这台机器是咕咕 server:没有窗口,扩展的 tab 在这里出现不了(behavior gugu-server-multi-device)。161 10-15 起
   * server 照样装 App(它的工具和技能给这台上的 agent 用),装完的回答当场说清 tab 在这里打不开;app_check 仍不能跑。
   */
  headless?: boolean;
  /** 可注入:真的那份要动 Electron session 与后台窗口。 */
  afterInstall?: (installed: { manifest: { id: string }; rootDir: string }) => void;
  /** F81 Where an App's source goes when the agent names no folder: `<this>/<id>` (main: appSourcesRoot). */
  appSourcesRoot?: () => string;
  /** The calling session's working copy, asked only when an agent passes a relative folder; null when it has none. */
  callerWorkspaceRoot?: () => Promise<string | null>;
  /** The calling session itself: app_check { file_path } runs the page as a tab of it (F94). */
  callerSessionId?: string;
  /** The agent of the calling session (`user:<uuid>`), null when it has none: the one who works the page app_check opens. */
  callerAgent?: () => Promise<string | null>;
  /** D-30 Whether an App is given to the calling session, as its catalog asks (main: the gateway's `inScopeOf`). */
  callerHasApp?: (extensionId: string) => Promise<boolean>;
  /** F5 The host runs one tab as a hidden page and reads it back (main `checkExtensionSurface`). */
  checkSurface?: (request: ExtensionCheckRequest) => Promise<ExtensionCheckReport>;
  /** `app_install { market }`: the market an agent installs from (main: `cloudExtensionMarket()`); injectable, it goes to the network. */
  market?: Pick<CloudExtensionMarket, 'entry' | 'list' | 'materialize' | 'hold' | 'held' | 'discard'>;
}

/** 咕咕 server 上 app_check 的那一句(给 agent,英文)。 */
export const HEADLESS_EXTENSION_CHECK_REFUSAL =
  'cannot check Apps here: this session runs on a Gugu server, which has no window to run an App\'s page in. Apps run in the Gugu desktop app.';

/** What `app_check` answers: the host's reading, and whether it is fit to tell the person. */
/** Owner 10-13: the page is still there, as the check left it. */
const kept = (report: ExtensionCheckReport) =>
  report.page ? `The page stays as it is now: app_check again with page "${report.page}" and more steps goes on from here (it closes ${EXTENSION_CHECK_PAGE_IDLE_MS / 60_000} min after, or when you app_install again). ` : '';

export function checkResult(report: ExtensionCheckReport, now = Date.now()) {
  // What the page threw also comes through the runtime's reportError (摩擦单 F63), as "<message> (<file>:<line>)": said
  // once, by the console's copy, which carries the line of source (F75).
  const thrown = new Set(report.errors.filter((error) => error.kind !== 'reportError' && error.source).map((error) => `${error.message} (${error.source})`));
  const own = report.errors.filter((error) => !(error.kind === 'reportError' && thrown.has(error.message)));
  // F68 The check's own page and the App's real pages in one list, each saying where it came from and how long ago.
  const errors = [
    ...own.map((error) => ({ ...error, page: error.kind === 'static' || error.kind === 'skill' ? 'the bundle' : 'this check' })),
    ...report.pages.map((record) => ({
      kind: 'reportError' as const,
      level: record.level,
      message: record.message,
      page: pageOf(record.page),
      ago: agoOf(record.at, now),
    })),
  ];
  const consoleErrors = report.console.filter((line) => line.level === 'error');
  // A hint (`level: 'hint'`, 摩擦单 F62) is for the author to read, not a failure; a real page's error is one.
  const failures = errors.filter((error) => error.level !== 'hint');
  const hints = errors.length - failures.length;
  // What it shows is not judged here: `text` goes back for the agent to read (摩擦单 F103 — a "blank" guess failed a page
  // that painted late under load). ok is what the page reported: loaded, settled, nothing thrown.
  // Owner 10-12 Steps the agent asked for: the check is ok only if each did what it said.
  const failedStep = report.steps?.find((step) => step.ok !== true);
  const ok = report.loaded && !report.stuck && failures.length === 0 && consoleErrors.length === 0 && failedStep === undefined;
  const why = report.stuck ? `It did not settle: at ${Math.round(report.elapsedMs / 1000)} s it was still waiting for ${STUCK_WORDS[report.stuck]}. ` : '';
  const stepWords = !report.steps
    ? ''
    : failedStep
      ? `Step ${failedStep.step} failed: ${failedStep.error}. A step that names the wrong control is yours to fix — its candidates say how to name the one you mean (with within) — a page that did not do what the step expected is the App's. `
      : `All ${report.steps.length} steps did what they said. `;
  const busy = report.readings ? busySentence(report.readings) : '';
  const heard = hints ? ` Hints (advice to you, not failures): ${hints} — read them.` : '';
  // The pictures go back as images (the tool registrar turns `pictures` into image blocks after this JSON).
  const look = report.pictures?.length
    ? `Look at the ${report.pictures.length} pictures after this text (${report.pictures.map((picture) => picture.label).join('; ')}): fix what looks wrong — cut off, crowded, unreadable, colours of your own instead of gugu's (guide apps-ui) — until it looks right. `
    : '';
  // #7126 Electron's own scripts failing while they started the page: gugu's problem, said as such, never counted in ok.
  const host = report.host?.length
    ? `gugu itself had trouble starting this page (host_errors, from Electron's own scripts): that is gugu's problem, not your App's — change nothing in your App for it.${ok ? '' : ' If the failures above may come from it, run app_check again before you change anything.'} `
    : '';
  return {
    ok,
    loaded: report.loaded,
    ...(report.loadError ? { load_error: report.loadError } : {}),
    ...(report.stuck ? { stuck: report.stuck } : {}),
    errors,
    console: report.console,
    ...(report.host?.length ? { host_errors: report.host } : {}),
    snapshot: report.snapshot,
    ...(report.steps ? { steps: report.steps } : {}),
    ...(report.readings?.shown.length ? { shown: report.readings.shown } : {}),
    ...(report.tools ? { tools: report.tools } : {}),
    ...(report.pictures?.length ? { pictures: report.pictures } : {}),
    ...(report.page ? { page: report.page } : {}),
    elapsed_ms: report.elapsedMs,
    next: ok
      ? `It loaded without errors.${heard} ${stepWords}${host}${busy}${report.tools?.length ? `Its tools for agents: ${report.tools.join(', ')}. ` : ''}Read snapshot too: it is what the person sees — if it says something is missing (no file bound, nothing to show), that is still a bug. ${look}${kept(report)}Tell the person it is done only when it works and looks right.`
      : `It does not work yet: ${why}${stepWords}fix what load_error, errors and console say, app_install again, and app_check again.${heard} ${host}${busy}${look}${kept(report)}Do not tell the person it is done until a check comes back ok.`,
  };
}

const STUCK_WORDS: Record<NonNullable<ExtensionCheckReport['stuck']>, string> = {
  load: 'the page to load',
  'files.open': 'gugu.files.open(…) to resolve or reject',
  quiet: 'the page to stop changing',
};

/** Which page a record came from, as the agent can find it again. */
function pageOf(page: ExtensionCheckReport['pages'][number]['page']): string {
  if (page.itemId && page.chatId) return `${page.tabKind} on file ${page.itemId} of chat ${page.chatId}`;
  if (page.chatId) return `${page.tabKind} in chat ${page.chatId}`;
  if (page.sessionId) return `${page.tabKind} in session ${page.sessionId}`;
  return page.tabKind;
}

function agoOf(at: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 90) return `${seconds} s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

/**
 * F69 What the check's page did, said as the agent reads it: how often it wrote and set presence, and how much it handed
 * back instead of the person's screen (`shown`, owner 10-14). Facts only: a file written every frame is the runtime's F62
 * hint alone, which reaches here through the pages' records.
 */
function busySentence(readings: NonNullable<ExtensionCheckReport['readings']>): string {
  const shown = readings.shown.length ? `; ${readings.shown.length} that would have reached your owner's screen came back to you in shown` : '';
  return `During the check it wrote ${readings.writes} times, at most ${readings.writesPerSecond} a second; set presence ${readings.presenceSets} times, at most ${readings.presencePerSecond} a second${shown}. `;
}

/**
 * #6634 问题 14 Where a folder an agent names is. An absolute path is used as is; anything else is taken from the calling session's working copy — never from gugu's own cwd, which is the home folder: W-21
 * measured Codex passing `readme-count` and `.gugu-extensions/readme-count` in all three runs and writing bundles into
 * `$HOME`, then working outside its sandbox (5 approvals) or rewriting the whole bundle in the project by hand.
 */
async function agentFolder(
  field: 'target_dir' | 'source_dir' | 'output_path',
  folder: string,
  callerWorkspaceRoot: (() => Promise<string | null>) | undefined
): Promise<string> {
  if (path.isAbsolute(folder)) return folder;
  const root = callerWorkspaceRoot ? await callerWorkspaceRoot() : null;
  if (!root) {
    throw new Error(`${field} "${folder}" is relative, and this session has no working copy to take it from; pass an absolute folder`);
  }
  return path.resolve(root, folder);
}

/**
 * F94 app_check { file_path }: the session's side of a check — a file of the caller's working copy, the page bound to
 * it as a session tab that claims it (worked as in a group). Never with a group's file or chat, never outside.
 */
async function sessionFileOf(
  filePath: string,
  action: { chat_id?: string; item_id?: string },
  callerWorkspaceRoot: (() => Promise<string | null>) | undefined,
  callerSessionId: string | undefined
): Promise<{ sessionId: string; filePath: string }> {
  if (action.chat_id || action.item_id) {
    throw new Error('app_check: file_path is a file of your working copy, in a session — give it without chat_id and item_id');
  }
  const root = callerWorkspaceRoot ? await callerWorkspaceRoot() : null;
  if (!root || !callerSessionId) throw new Error('app_check: file_path needs a session with a working copy');
  // The same containment as every other path an App or agent names (symlinks resolved): one check, never a second copy.
  // An agent's path is often absolute: said from the working copy first (L11 R19).
  const full = resolvesInside(root, path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath);
  if (!full) throw new Error(`app_check: ${filePath} is not a file of your working copy (${root})`);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`app_check: no file ${filePath} in your working copy`);
  return { sessionId: callerSessionId, filePath: path.relative(root, full).split(path.sep).join('/') };
}

function createNext({ newlyAsked, asks }: ReturnType<typeof installPlan>): string {
  if (!asks) return 'Call app_install with this source_dir to make its tabs appear.';
  return `The next install call will ask the person to review and decide${newlyAsked.length > 0 ? ` on ${newlyAsked.join(', ')}` : ''}.`;
}

/**
 * `tab_kind` is the address open_in_tab and app_check take, handed over whole. ❌ 别只给 id 和 name 让调用方
 * 自己拼 —— 一个能直接给出的地址,留给对方拼就是留给对方猜分隔符,而猜错的那一次会安静地开出一个 unavailable tab。
 */
function tabKinds(manifest: ExtensionManifest) {
  return manifest.contributes.tabs.map((tab) => {
    const chatFiles = claimedSuffixes(tab, 'chat');
    // F40 The chat files a tab opens: what app_install { data } names the chat's data file after.
    return { name: tab.name, tab_kind: extensionTabKind(manifest.id, tab.name), ...(chatFiles.length > 0 ? { chat_files: [...chatFiles] } : {}) };
  });
}

/**
 * F15 (L7-d) What comes after a folder install. The agent now has its App; the chat it is for does not, and nothing
 * said so — L7 measured agents stopping at "installed" while the others had nothing to open the file with. Once told,
 * an agent then asked its own owner to install from the card too, on the very computer it had installed on: so the
 * answer says whose computer already has it.
 */
/** F52 Installed is installed: a window that has not taken it in yet is one more sentence, first, never an error. */
function withWindowNote<T extends { next?: string }>(shown: 'shown' | 'pending' | 'failed', answer: T): T {
  const window = windowNoteOf(shown);
  return window ? { ...answer, window: window.window, next: answer.next ? `${window.note} ${answer.next}` : window.note } : answer;
}

function installNext(
  manifest: ExtensionManifest,
  /** What `app_install` was given, as the agent passes it again with chat_id: `{"source_dir":…}` or `{"market":…}`. */
  from: { source_dir: string } | { market: string },
  { checkAvailable, sentToGroup }: { checkAvailable: boolean; sentToGroup: boolean },
  /** `skillsLeftOut`: said first, on either path (the quiet reinstall too — an author fixing one goes that way). */
  leftOut: readonly string[]
): { next?: string } {
  const chatTab = manifest.contributes.tabs.find((tab) => claimedSuffixes(tab, 'chat').length > 0);
  // 摩擦单 F114① (S23: an App claiming a working copy's TODO.md was never checked on it) A session's file is checked as a group's is.
  const sessionTab = manifest.contributes.tabs.find((tab) => claimedSuffixes(tab, 'session').length > 0);
  const checked = chatTab ?? sessionTab ?? manifest.contributes.tabs[0];
  const parts = leftOut.map((message) => `No agent gets this skill: ${message}`);
  if (checked?.hostPage) {
    parts.push('Open its tab_kind to review the host settings page. Use Check connection there to start its programs and read their actual status.');
  } else if (checkAvailable && checked) {
    const onFile = chatTab
      ? ',"item_id":"<a file of the chat it opens>"'
      : sessionTab ? ',"file_path":"<a file of your working copy it opens>"' : '';
    parts.push(`app_check {"tab_kind":"${extensionTabKind(manifest.id, checked.name)}"${onFile}} until it is ok.`);
  }
  if (chatTab && sentToGroup) {
    parts.push(
      'Your owner\'s computer — this one — has it installed, and it is in the chat as a card now: the others ' +
        'install it from the card or when they open one of its files.'
    );
  } else if (chatTab) {
    // 集体记忆对账第 6 条:进群只指一条路(app_install 带 chat_id),❌ 再并列一个 app_pack(owner-no-compat-multi-paths)。
    parts.push(
      'Your owner\'s computer — this one — has it installed now; nobody else in the chat has it yet → ' +
        `app_install {${JSON.stringify(from).slice(1, -1)},"chat_id":"<the chat>"} again ` +
        'sends it into the chat, and they install it from the card or when they open one of its files.'
    );
  }
  return parts.length > 0 ? { next: parts.join(' ') } : {};
}

/**
 * `app_install { market }`: the version of that App this machine can install — named by its id, or by a name its card
 * shows when the market's search finds exactly one. What cannot be installed says why, and what to do — before anything
 * is fetched.
 */
async function marketOffer(asked: string, market: Pick<CloudExtensionMarket, 'entry' | 'list'>): Promise<CloudMarketEntry> {
  // The market's index taken now, not the copy from when the Apps page was last opened: an App published while gugu
  // runs is not in that one. The search below reads the index this call just took.
  // Whether this machine can run it is said once, where every install path fetches it (`materialize`).
  return (await market.entry(asked, true)) ?? (await onlyMatch(market, asked));
}

/**
 * The agent's install from the market: the one path (installExtensionFromMarket) — fetched, checked, asked as an approval
 * in its session, installed as the market's App (gugu's) — with what an agent is told after: its tabs, whether its tools
 * reach the caller, what to call next.
 */
async function installFromMarketForAgent(
  asked: string,
  chatId: string | undefined,
  following: { checkAvailable: boolean; sentToGroup: boolean },
  dependencies: ExtensionAgentActionDependencies
) {
  const market = dependencies.market ?? (await import('./market-catalog-root')).cloudExtensionMarket();
  // `<id or name>@<version>` (owner 10-19, VS Code's `--install-extension id@version`): that version, not this machine's.
  const at = /^(.+)@(\d+\.\d+\.\d+)$/.exec(asked.trim());
  const entry = await marketOffer(at ? at[1]! : asked, market);
  const requestInstallConsent = dependencies.requestInstallConsent ?? requestExtensionInstallConsent;
  const result = await installExtensionFromMarket(
    { ref: { extensionId: entry.manifest.id, version: at ? at[2]! : entry.version }, ...(chatId !== undefined ? { chatId } : {}) },
    {
      market,
      requestInstallConsent: async (request) => {
        try {
          return await requestInstallConsent(request);
        } catch (error) {
          // No window to ask in (and no session approval injected): the agent is told what the person has to allow.
          if (!dependencies.requestInstallConsent) throw new AgentPermissionRefusal(declaredPermissions(request.manifest));
          throw error;
        }
      },
      ...(dependencies.notifyInstalledChanged ? { notifyInstalledChanged: dependencies.notifyInstalledChanged } : {}),
      ...(dependencies.afterInstall ? { afterInstall: dependencies.afterInstall } : {}),
    }
  );
  if (!result.installed) return { installed: false, outcome: result.outcome, id: result.id, name: result.name };
  const service = extensionsService();
  return withWindowNote(result.announced, {
    installed: true,
    outcome: 'confirmed',
    id: result.id,
    name: result.name,
    version: result.version,
    tabs: tabKinds(result.manifest),
    ...(result.asked
      ? forAgentsNote(result.manifest, service.disclosure(result.id) === 'full', await callerHasApp(dependencies, result.id))
      : {}),
    ...pinnedNext(result, installNext(result.manifest, { market: result.id }, following, skillsLeftOut(result))),
  });
}

/** An older version than the market's, asked for: it stays at it — said first, with where the person undoes that. */
function pinnedNext(result: { id: string; version: string; pinned?: true }, after: { next?: string }): { next?: string } {
  if (!result.pinned) return after;
  const pinned = `${result.id} stays at ${result.version}: it is no longer updated by itself until your owner turns its auto update back on in the Apps page.`;
  return { next: after.next ? `${pinned} ${after.next}` : pinned };
}

/** A name rather than an id: the market's own search, taken only when it finds one App. */
async function onlyMatch(market: Pick<CloudExtensionMarket, 'list'>, asked: string): Promise<CloudMarketEntry> {
  const listing: CloudMarketListing = await market.list({ search: asked });
  const [only, ...more] = listing.extensions;
  if (only && more.length === 0) return only;
  if (!only) throw new Error(`app_install: the market has no App "${asked}" — check its name with the person`);
  const found = listing.extensions.map((entry) => `${entry.manifest.id} (${entry.manifest.name})`).join(', ');
  throw new Error(
    `app_install: "${asked}" matches ${listing.total} Apps in the market: ${found}${listing.hasMore ? ', …' : ''} — pass market with one of these ids`
  );
}

/**
 * 咕咕 server 上装好之后的那一句(给 agent,英文):161 10-15 起 server 照样装(缺口 2,改法 A),但它没有窗口 —— tab 在这里
 * 打不开,app_check 也跑不了;它的工具和技能给这台上的 agent 用。
 */
export const HEADLESS_INSTALLED_NOTE =
  'Installed on this Gugu server, which has no window: its tabs open nowhere here (and app_check cannot run here); its tools and skills are for the agents on this server, as the person gave them.';

export async function runExtensionAgentAction(
  rawAction: unknown,
  dependencies: ExtensionAgentActionDependencies = {}
): Promise<unknown> {
  const action = agentActionSchema.parse(rawAction);
  const answer = await actOn(action, dependencies);
  if (!dependencies.headless || (action.action !== 'install' && action.action !== 'install_attachment')) return answer;
  const installed = answer as { installed?: boolean; next?: string };
  if (installed.installed !== true) return answer;
  return { ...installed, next: installed.next ? `${HEADLESS_INSTALLED_NOTE} ${installed.next}` : HEADLESS_INSTALLED_NOTE };
}

/**
 * A folder's App installed here (origin 'folder', the account signed in here its publisher — app-identity.ts): the agent's
 * own `source_dir`, or (#7290 `install_folder_package`) the owner's folder packed on their other machine. D-31 `consent`:
 * that machine asks the person — `return` hands back what would be asked, `given` installs the bytes they agreed to only.
 */
async function installFolder(
  sourceDir: string,
  { chatId, consent, from, following }: {
    chatId: string | undefined;
    consent?: HandedConsent;
    /** What `app_install` was given, said again in its next step; none for a package from another machine. */
    from: { source_dir: string } | null;
    following: { checkAvailable: boolean; sentToGroup: boolean };
  },
  dependencies: ExtensionAgentActionDependencies,
) {
  const service = extensionsService();
  const inspected = service.inspectDirectory(sourceDir);
  // #6646 E-05: replacing one from another source — the market's by a folder, a chat's, one installed before origins
  // were kept — is the person's call even for a bundle asking nothing; the same source asking for nothing new stays
  // quiet (the one rule, upgrade.ts `replacesWithoutAsking`).
  const variant = await prepareForkVariant(sourceDir);
  const preparedVariant = variant ? prepareVariant(sourceDir, variant) : null;
  const plan = installPlan(service, inspected.manifest, variant ? 'fork' : 'folder');
  const done = await installPrepared(preparedVariant ?? {
    dir: sourceDir,
    manifest: inspected.manifest,
    manifestDigest: inspected.manifestDigest,
    origin: 'folder',
    // A folder's App is the account installing it (app-identity.ts).
    publisher: await (await import('./app-files')).folderPublisher(),
    asks: plan.asks,
    sheet: { installed: plan.approved, revokedPermissions: plan.revokedPermissions },
    // D-30: an App's first install here asks which agents get its tools — every agent here ticked at first; so does
    // installing it again for a chat it is not given at (125 10-07), that chat ticked, even when the bundle asks nothing new.
    places: { first: !plan.displaced, chatId, identity: await (await import('./app-given')).ownInstallIdentity(inspected.manifest.id, 'folder') },
  }, consent ?? { kind: 'here' }, {
    ...dependencies,
    // Asked in the agent's session; with no one there to ask, the refusal says what it would have asked for.
    requestInstallConsent: dependencies.requestInstallConsent ?? ((request) =>
      requestExtensionInstallConsent(request).catch(() => { throw new AgentPermissionRefusal(declaredPermissions(inspected.manifest)); })),
  });
  const summary = { id: inspected.manifest.id, name: inspected.manifest.name };
  if (done.outcome === 'ask') return { installed: false, ...summary, version: inspected.manifest.version, ...done };
  if (done.outcome !== 'confirmed') return { installed: false, outcome: done.outcome, ...summary };
  const installed = done.installed;
  // 装完喊一声,新 tab 这才在 tab 栏里出现 —— 不喊就得整页刷新(owner 实测 #4135)。F52 喊了不等它点头才算装上。
  return withWindowNote(done.announced, {
    installed: true,
    outcome: 'confirmed' as const,
    id: installed.manifest.id,
    name: installed.manifest.name,
    version: installed.manifest.version,
    tabs: tabKinds(installed.manifest),
    ...(done.asked ? forAgentsNote(installed.manifest, service.disclosure(installed.manifest.id) === 'full', await callerHasApp(dependencies, installed.manifest.id)) : {}),
    ...(from ? installNext(installed.manifest, from, following, skillsLeftOut(installed)) : {}),
  });
}

async function actOn(action: z.infer<typeof agentActionSchema>, dependencies: ExtensionAgentActionDependencies): Promise<unknown> {
  switch (action.action) {
    case 'create': {
      if (action.fork_of) return createAppFork(action.fork_of, action.name);
      if (!action.id || !action.name) throw new Error('app_create: give id and name for a new App, or fork_of to fork an installed App');
      // F40 (S2: 8 calls, most of the time model round trips) The agent's own files go in with the bundle, over the
      // template's: an App written in this call needs no Read + Edit of the skeleton afterwards.
      const ownAppJs = action.files?.['app.js'] !== undefined;
      // F81 (S23: the App's source landed in the person's repository) No folder named: outside every working copy.
      const ownFolder = action.target_dir === undefined;
      if (ownFolder && !dependencies.appSourcesRoot) throw new Error('app_create: give target_dir — this host has no App folder of its own');
      const targetDir = ownFolder
        ? path.join(dependencies.appSourcesRoot!(), action.id)
        : path.resolve(await agentFolder('target_dir', action.target_dir!, dependencies.callerWorkspaceRoot));
      const existing = bundleThere(targetDir, action.id);
      const bundle = bundleOf(action, existing);
      // Updating in place: a template's files fill only what the folder lacks — the agent's edits of them stay.
      const templateFiles = Object.fromEntries(
        Object.entries(bundle.templateFiles).filter(([name]) => !existing || !fs.existsSync(path.join(targetDir, name)))
      );
      const { sourceDir, manifest } = scaffoldExtension({
        targetDir,
        manifest: bundle.manifest,
        files: { ...templateFiles, ...bundle.files },
        update: existing !== null,
      });
      // Said here rather than discovered at install: the agent is holding the pen right now.
      const templateNote =
        action.template === 'group-json'
          ? groupJsonNote(chatSuffixOf(manifest.contributes.tabs[0]?.opensFiles) ?? templateFileSuffix(manifest.id), sourceDir, ownAppJs)
          : '';
      const toWrite = programFilesNote(manifest.contributes.mcpServers, sourceDir) + skillsNote(manifest.contributes.skills) + templateNote;
      const plan = installPlan(extensionsService(), manifest);
      const updated =
        (ownFolder ? `Written to ${sourceDir}, this computer's App folder — outside your working copy. ` : '') +
        (existing
          ? 'Updated in place (the same App): what this call gave was laid over the manifest there, its files written, the rest of the folder kept. '
          : '');
      return {
        source_dir: sourceDir,
        id: manifest.id,
        ...(existing ? { updated: true } : {}),
        tabs: manifest.contributes.tabs.map((tab) => tab.name),
        // The skeleton comes back only when the agent has not written its own app.js yet.
        ...(action.template && !ownAppJs ? { app_js: fs.readFileSync(path.join(sourceDir, 'app.js'), 'utf8') } : {}),
        // Said here rather than discovered at install: the agent is holding the pen
        // right now, and the person should know whether the next install call will
        // ask for consent rather than silently granting anything.
        // The template's note already names the install call; only a consent it will ask for is added.
        next: `${updated}${toWrite}${templateNote && !plan.asks ? '' : createNext(plan)}`,
      };
    }
    case 'pack': {
      const sourceDir = await agentFolder('source_dir', action.source_dir, dependencies.callerWorkspaceRoot);
      const { bytes, sha256, manifest } = await packExtensionArchive(extensionsService(), sourceDir);
      const fileName = `${manifest.id}-${manifest.version}${EXTENSION_ARCHIVE_SUFFIX}`;
      // F12 (L6 S6) output_path is optional: by default next to the bundle folder, a short path the agent copies into
      // message_send_file (not macOS's /var/folders/…/T, full of look-alike zeros models miscopy). Given, a path
      // ending in .guguext is the file, anything else a folder; missing folders are made rather than refused.
      const out =
        action.output_path === undefined ? null : await agentFolder('output_path', action.output_path, dependencies.callerWorkspaceRoot);
      const filePath = out === null
        ? path.join(path.dirname(sourceDir), fileName)
        : out.endsWith(EXTENSION_ARCHIVE_SUFFIX) ? out : path.join(out, fileName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, bytes);
      return {
        file_path: filePath,
        file_name: fileName,
        mime_type: EXTENSION_ARCHIVE_MIME,
        size: bytes.byteLength,
        sha256,
        id: manifest.id,
        version: manifest.version,
        next: 'Send file_path with message_send_file; the chat shows it as an App card the people there can install.',
      };
    }
    case 'bump': {
      // 摩擦单 F107: the version goes up one patch, written back into the bundle's manifest.json, so the card the group
      // gets is a version of its own — people who installed the earlier one are offered it.
      const sourceDir = await agentFolder('source_dir', action.source_dir, dependencies.callerWorkspaceRoot);
      const file = path.join(sourceDir, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string };
      const [major, minor, patch] = manifest.version.split('.').map(Number);
      const version = `${major}.${minor}.${patch! + 1}`;
      fs.writeFileSync(file, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
      return { version };
    }
    case 'install': {
      if ((action.source_dir === undefined) === (action.market === undefined)) {
        throw new Error('app_install takes exactly one of source_dir, source_message_id or market');
      }
      // A Gugu server has no window to run a page in: app_check is not offered as the next step there.
      const following = { checkAvailable: dependencies.checkSurface !== undefined && !dependencies.headless, sentToGroup: action.chat_id !== undefined };
      // App 市场方案 10-07: an App from the market installs the one way every place installs one (installExtensionFromMarket,
      // 161 10-15) — the agent names which App, never where its bytes come from; the person is asked in its session.
      if (action.variant !== undefined) {
        if (!action.market || action.chat_id || action.device || action.source_dir) throw new Error('Switch a variant with app_install {market: <App id>, variant: <name>} only.');
        const result = await switchExtensionVariant(action.market, action.variant, undefined, dependencies);
        return result.installed ? { ...result, tabs: tabKinds(result.manifest), next: `Variant ${action.variant} is active; the App data and where it is enabled are kept.` } : result;
      }
      if (action.market !== undefined) return installFromMarketForAgent(action.market, action.chat_id, following, dependencies);
      const sourceDir = await agentFolder('source_dir', action.source_dir!, dependencies.callerWorkspaceRoot);
      return installFolder(sourceDir, { chatId: action.chat_id, from: { source_dir: sourceDir }, following }, dependencies);
    }
    case 'receive_package_part': {
      const { from_device: fromDevice, action: _receive, ...part } = action;
      return receivePackagePart(fromDevice, part);
    }
    case 'install_folder_package': {
      // The owner's folder from their other machine (app_install { device }): installed as a folder is, from these bytes only.
      // Kept for the install of what the person agreed to after an ask (`consent: return`); otherwise gone once answered.
      let asked = false;
      try {
        const bytes = readReceivedPackage(action.from_device, action.upload_id);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== action.digest) {
          throw new Error(`the App package received is not the one the other machine packed (sha256 ${sha256}, expected ${action.digest}): not installed`);
        }
        const { dir } = await unpackExtensionArchive(extensionsService(), bytes, path.join(os.tmpdir(), 'gugu-folder-packages'));
        try {
          const following = { checkAvailable: false, sentToGroup: false };
          const result = await installFolder(dir, { chatId: action.chat_id, consent: action.consent, from: null, following }, dependencies);
          asked = (result as { outcome?: unknown }).outcome === 'ask';
          return result;
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } finally {
        if (!asked) dropReceivedPackage(action.from_device, action.upload_id);
      }
    }
    case 'pack_installed': {
      const { bytes, sha256, fileName, manifest } = await packInstalledExtension(extensionsService(), action.id);
      // The host's own folder, outside every working copy: the card is sent from it, and the next card of this version
      // overwrites it.
      const dir = path.join(os.tmpdir(), 'gugu-app-cards');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, fileName);
      fs.writeFileSync(filePath, bytes);
      return {
        file_path: filePath,
        file_name: fileName,
        mime_type: EXTENSION_ARCHIVE_MIME,
        size: bytes.byteLength,
        sha256,
        id: manifest.id,
        version: manifest.version,
      };
    }
    case 'ask_install':
      // A Gugu server asks too: as this agent's approval in its session, followed from a phone or a desktop (D-31 ③).
      return (dependencies.requestInstallConsent ?? requestExtensionInstallConsent)(action.request);
    case 'install_attachment': {
      const result = await installExtensionFromAttachment({ messageId: action.message_id, ...(action.consent ? { consent: action.consent } : {}) }, dependencies);
      // E-05 for an agent is what it always was: an error with the install's own reason (the card says it to a person).
      if (result.outcome === 'refused') throw new Error(result.reason);
      if (!result.installed) return result;
      const { manifest } = extensionsService().get(result.id);
      return {
        ...result,
        tabs: manifest.contributes.tabs.map((tab) => ({ name: tab.name, tab_kind: extensionTabKind(manifest.id, tab.name) })),
        ...forAgentsNote(manifest, extensionsService().disclosure(result.id) === 'full', await callerHasApp(dependencies, result.id)),
      };
    }
    case 'check': {
      if (dependencies.headless) throw new Error(HEADLESS_EXTENSION_CHECK_REFUSAL);
      const kind = parseExtensionTabKind(action.tab_kind);
      if (!kind) {
        throw new Error(`app_check: "${action.tab_kind}" is not a tab_kind (<App id>.<tab name>) — take it from app_install or app_search`);
      }
      const service = extensionsService();
      const entry = service.list().extensions.find((candidate) => candidate.manifest.id === kind.extensionId);
      if (!entry) {
        throw new Error(`app_check: ${kind.extensionId} is not installed — app_install it first (app_search shows what is)`);
      }
      if (!service.isEnabled(kind.extensionId)) {
        throw new Error(`app_check: ${kind.extensionId} is switched off; the person switches it back on in Apps`);
      }
      const tabs = entry.manifest.contributes.tabs;
      const tab = tabs.find((candidate) => candidate.name === kind.tabName);
      if (!tab) {
        throw new Error(`app_check: ${kind.extensionId} has no tab "${kind.tabName}"; its tab_kinds: ${tabs.map((candidate) => extensionTabKind(kind.extensionId, candidate.name)).join(', ')}`);
      }
      // The tool is listed only where it works (F14); a host without it answering anyway is a build that got here by accident.
      if (!dependencies.checkSurface) throw new Error('app_check is not available in this build of gugu');
      if (action.page !== undefined && [action.chat_id, action.item_id, action.file_path, action.phone].some((given) => given !== undefined)) {
        throw new Error('app_check: a page goes on where it opened, at its size — give page with tab_kind and steps alone');
      }
      if (action.phone !== undefined && !action.steps) throw new Error('app_check: phone is the size steps run at — give it with steps');
      const badKey = action.steps?.findIndex((step) => 'press' in step && !isExtensionStepKey(step.press)) ?? -1;
      if (badKey >= 0) {
        const { press } = action.steps![badKey] as { press: string };
        throw Object.assign(new Error(`app_check: step ${badKey + 1} presses "${press}" — press takes ${EXTENSION_STEP_KEYS.join(', ')}`), { code: 'invalid' });
      }
      const caller = dependencies.callerSessionId;
      // Where it opens (owner 10-13): a file of the session's working copy; a group's file; a tab that claims no file is the
      // App's own page, a tab of the caller's session as it opens there.
      const session = action.file_path !== undefined
        ? await sessionFileOf(action.file_path, action, dependencies.callerWorkspaceRoot, caller)
        : !action.chat_id && caller && declaredContexts(tab).length === 0 ? { sessionId: caller } : null;
      // Owner 10-14: the page is worked by the agent that asks — what it does there is done in that agent's name; with no
      // agent asking, nobody works it (the person never sees it), so there is no check.
      const agent = caller ? await dependencies.callerAgent?.() : undefined;
      if (!caller || !agent) throw new Error('app_check: the page is worked by the agent that asks, and none asks here');
      const report = await dependencies.checkSurface({
        extensionId: kind.extensionId,
        tabName: tab.name,
        ...(action.chat_id ? { chatId: action.chat_id } : {}),
        ...(action.item_id ? { itemId: action.item_id } : {}),
        ...(session ?? {}),
        timeoutMs: EXTENSION_CHECK_TIMEOUT_MS,
        ...(action.steps ? { steps: action.steps } : {}),
        ...(action.phone ? { phone: true } : {}),
        caller,
        operator: { kind: 'agent', id: agent },
        ...(action.page ? { page: action.page } : {}),
      });
      return checkResult(report);
    }
  }
}
