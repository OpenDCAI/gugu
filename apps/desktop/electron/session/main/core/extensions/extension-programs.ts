import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ErrorCode, McpError, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolRequest, CallToolResult, Notification, Progress, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ExtensionAgentStatus, ExtensionProgramFailure } from '@shared/extensions/agent-status';
import { log } from '@main/lib/logger';
import { OwnedStdioTransport, lastStderrLine } from '@main/core/mcp/owned-stdio-transport';
import { extensionsService } from './extensions-root';
import { programRuntimePath } from './app-runtime-dir';
import { PROGRAM_CALL_META_KEY } from '@shared/extensions/app-runtime-protocol';
import { parseGroupFileLink } from '@gugu/core/shared/ui/guguLink';
import { firstSentence } from '../../../../mcp/first-sentence';
import { runHumanTool, humanToolPending } from '../asks/human-tool-wait';
import type { ProgramRequestScope } from './app-human-request';
import {
  attachProgramSurface,
  handedChatsAs,
  handedFilesAs,
  type ExtensionHandedChat,
  type ExtensionHandedFile,
  type ProgramSurface,
} from './extension-program-surface';

export type { ExtensionHandedChat, ExtensionHandedFile };

/**
 * Extension MCP programs, run by gugu itself and shared by every agent session (Refs #6615).
 * Sessions reach them only through gugu's extension gateway.
 *
 * Invariants:
 * - One process per (extension, program), always the version installed now: an upgrade retires the old
 *   one (at once if idle, else as soon as its calls finish) and the next call starts the new version.
 * - Started on first use, stopped after `IDLE_MS` without a call in flight; stopping takes the whole tree.
 * - The extension's own pages reach the same process as its sessions (Refs #6635): the host registers the one
 *   descriptor source both use, and a page may call only tools whose MCP Apps visibility includes `app`.
 */

/** Host resources an App reaches as a program (`"host"` in its manifest): Browser Use, and Computer Use (#7317). */
export type NativeProgramHost = 'browser-use' | 'computer-use';

export interface ExtensionProgram {
  native?: NativeProgramHost;
  extensionId: string;
  /** The program's name in the manifest. */
  server: string;
  /** Manifest digest of the version this program comes from. */
  digest: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** The extension's data folder, which the program is told about (`GUGU_EXTENSION_DATA_DIR`); made before it starts. */
  dataDir: string;
  /** F16 It runs on gugu's own node (`"command": "node"`): it gets the global `gugu`, as the App's pages do. */
  onGuguNode?: true;
}

export interface ExtensionPrograms {
  registerNative(name: NativeProgramHost, provider: NativeAppProgram): void;
  /** Why the extension may not give agents tools right now (not installed, turned off, revoked); null when it may. */
  agentToolsRefusal(extensionId: string): string | null;
  tools(program: ExtensionProgram): Promise<Tool[]>;
  /**
   * What the program said about itself when it last started (MCP initialize `instructions`), cut to its first sentence:
   * read only when it gives agents nothing — a program that needs setting up says what is missing in its own words.
   */
  instructions(program: ExtensionProgram): string | undefined;
  /**
   * `handed`: group files this call hands the program (F16 `format: "gugu-file"`), open to it until the call ends;
   * `handedChats`: chats it hands (A1 `format: "gugu-chat"`), where the program acts as the agent until the call ends.
   * Each call gets an id of its own (`_meta['gugu/call']`): the program's verbs made in it say it, and are answered as
   * this call's agent (`agent`, a bare uuid; absent when gugu does not know it — then nothing is done as anyone) — never
   * by which calls hold the same file or chat at the moment.
   */
  call(program: ExtensionProgram, params: CallToolRequest['params'],
    options: { signal: AbortSignal; sessionId?: string; onprogress?: (progress: Progress) => void; agent?: string; handed?: readonly ExtensionHandedFile[];
      handedChats?: readonly ExtensionHandedChat[] }): Promise<CallToolResult>;
  /** Which group each file is in, read as this agent; throws, naming the file, when the agent cannot open one. */
  handedFiles(agentUserId: string, itemIds: readonly string[]): Promise<ExtensionHandedFile[]>;
  /** A1 Each chat as its id, in the order asked, the agent in it; throws, naming the chat, when the agent is not. */
  handedChats(agentUserId: string, chatIds: readonly string[]): Promise<ExtensionHandedChat[]>;
  /** A signal exit has no time to be graceful: kill every program tree now, synchronously. */
  killAllSync(): void;
  /** The host registers where the installed programs come from — the same descriptors sessions get. */
  setSource(source: () => ExtensionProgram[]): void;
  /** Every extension's programs as installed now: what the catalog, the gateway and pages all read. */
  installed(): ExtensionProgram[];
  /**
   * One of the extension's own pages calls a tool of its own program (`server` only when it runs several).
   * `from` is the calling tab's task as the host bound it — or, on a page an agent works (owner 10-14), that agent and
   * its own session; absent for the background page.
   */
  callFromPage(extensionId: string, request: {
    server?: string; name: string; arguments?: Record<string, unknown>; from: { sessionId?: string } | { agent: string; agentSession?: string };
  }): Promise<CallToolResult>;
}

/** A host resource driven through the same App gateway, caller stamps, catalog and revocation as stdio programs. */
export interface NativeAppProgram {
  tools(): Promise<Tool[]>;
  call(program: ExtensionProgram, params: CallToolRequest['params'], signal: AbortSignal): Promise<CallToolResult>;
  status(extensionId: string): Pick<ExtensionAgentStatus, 'running' | 'sessions'>;
  retire(extensionId: string): Promise<void>;
}

const nativePrograms = new Map<NativeProgramHost, NativeAppProgram>();
function nativeProgram(program: ExtensionProgram): NativeAppProgram {
  const provider = program.native && nativePrograms.get(program.native);
  if (!provider) throw new Error(`Host capability is unavailable: ${program.native}`);
  return provider;
}

/**
 * Why a program failed, as told to an agent next to its name: the error's words on one line, cut at 300 characters,
 * without the「extension X: program P」this module's own errors open with.
 */
export function programFailureReason(program: Pick<ExtensionProgram, 'extensionId' | 'server'>, error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const own = `extension ${program.extensionId}: program ${program.server} `;
  const flat = (text.startsWith(own) ? text.slice(own.length) : text).replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

const IDLE_MS = 5 * 60_000;
// The harness owns the call's deadline and cancels through the signal; the SDK's 60 s default would cut long tools short.
const NO_TIMEOUT_MS = 2 ** 31 - 1;

/** F16 A tool parameter with this JSON Schema format is a group file handed to the program for the call (its item id, or the gugu-file:// link that names it). */
export const HANDED_FILE_FORMAT = 'gugu-file';
/** A1 A tool parameter with this format is a chat handed to the program for the call (its id, or the number people see — as text or a JSON number). */
export const HANDED_CHAT_FORMAT = 'gugu-chat';

type FormatSchema = Record<string, { format?: unknown; items?: { format?: unknown } }>;

/**
 * One handed argument as the text it names: a string as sent, with two other spellings of the same thing —
 * - a file as its `gugu-file://<id>` link (片场试演 10-12: a writer handed the table as the link the round's message carries,
 *   the very link `gugu.dispatch` writes) is that id — handed, checked as the agent, and reaching the program as the id;
 * - a chat named by the number people see may come as a JSON number (A/B 10-12: Codex sent 211178 bare) and is that number's
 *   text — handed, checked as the agent, and made the chat's id like the same number in quotes.
 * Anything else names nothing: it is handed nothing and reaches the program as sent.
 */
function handedText(value: unknown, format: string): string | undefined {
  if (typeof value === 'string') return format === HANDED_FILE_FORMAT ? (parseGroupFileLink(value)?.itemId ?? value) : value;
  return format === HANDED_CHAT_FORMAT && Number.isSafeInteger(value) && (value as number) > 0 ? String(value) : undefined;
}

/** What a call hands its program under `format` (gugu-file, gugu-chat): arguments, or arrays of them, whose schema says so, as handedText reads them. */
export function handedIds(tool: Tool | undefined, args: Record<string, unknown> | undefined, format: string): string[] {
  const properties = (tool?.inputSchema.properties ?? {}) as FormatSchema;
  const ids: string[] = [];
  for (const [key, schema] of Object.entries(properties)) {
    const value = args?.[key];
    const given = schema?.format === format ? [value] : schema?.items?.format === format && Array.isArray(value) ? value : [];
    for (const text of given.map((one) => handedText(one, format))) if (text !== undefined) ids.push(text);
  }
  return [...new Set(ids)];
}

/**
 * The arguments as the program gets them, each handed thing as the id it was checked as: a chat named by the number people
 * see reaches the program as the chat it is, a file named by its gugu-file:// link as its id.
 */
function withHandedIds(tool: Tool | undefined, args: Record<string, unknown> | undefined, chats: ReadonlyMap<string, string>) {
  if (!args) return args;
  const properties = (tool?.inputSchema.properties ?? {}) as FormatSchema;
  const named = (format: string) => (value: unknown) => {
    const text = handedText(value, format);
    return text === undefined ? value : format === HANDED_CHAT_FORMAT ? (chats.get(text) ?? text) : text;
  };
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      const schema = properties[key];
      for (const format of [HANDED_CHAT_FORMAT, HANDED_FILE_FORMAT]) {
        if (schema?.format === format) return [key, named(format)(value)];
        if (schema?.items?.format === format && Array.isArray(value)) return [key, value.map(named(format))];
      }
      return [key, value];
    }),
  );
}

/**
 * 摩擦单 F16 Who called, as every id an App sees (F35): the agent's `user:<uuid>`, the same on every machine — what
 * `gugu.dispatch` takes and a group's `members` list. A program keeps it (a card's follower) and wakes that agent later.
 */
export const AGENT_META_KEY = 'gugu/agent';
/** #6615 问题 11 The caller's session — the same key its pages' calls carry. */
export const SESSION_META_KEY = 'gugu/sessionId';
/** #6615 问题 11 The caller's working copy: a program runs in its bundle and could not know the project otherwise. */
export const WORKSPACE_META_KEY = 'gugu/workspaceRoot';
/** The model gugu runs the caller's session on, as `listAgents()` gives it — an App shows which model did a thing (片场's cards). */
export const MODEL_META_KEY = 'gugu/model';
export const MODEL_LABEL_META_KEY = 'gugu/modelLabel';

/** Where the calling session works, read at call time; null when the session is not a session-page one. */
export type CallerSessionContext = (agentId: string) => Promise<{ sessionId: string; workspaceRoot: string | null; model: string | null; modelLabel?: string | null } | null>;

/** The agent calling: its session here (`agentId`) and its gugu identity (`agentUserId`, a uuid). */
export interface Caller {
  agentId?: string;
  agentUserId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The caller's `user:<uuid>`; nothing for an id that is not one (a program must be able to hand it to `gugu.dispatch`). */
export function agentAddress(agentUserId: string | undefined): string | null {
  const bare = agentUserId?.replace(/^user:/, '');
  return bare && UUID.test(bare) ? `user:${bare}` : null;
}

/** The `_meta` a program receives: who called, and — when known — from which session, working copy and model. */
export async function callerMeta(caller: Caller, sessionContext?: CallerSessionContext): Promise<Record<string, string>> {
  const agent = agentAddress(caller.agentUserId);
  const context = caller.agentId && sessionContext ? await sessionContext(caller.agentId) : null;
  return {
    ...(agent ? { [AGENT_META_KEY]: agent } : {}),
    ...(context ? { [SESSION_META_KEY]: context.sessionId } : {}),
    ...(context?.workspaceRoot ? { [WORKSPACE_META_KEY]: context.workspaceRoot } : {}),
    ...(context?.model ? { [MODEL_META_KEY]: context.model } : {}),
    ...(context?.modelLabel ? { [MODEL_LABEL_META_KEY]: context.modelLabel } : {}),
  };
}

/**
 * What a call made as `agent` (a bare uuid) hands its program (F16, A1): the group files and chats its arguments name,
 * each checked as that agent — a program never reaches a file or a chat through an agent that could not — and the
 * arguments as the program gets them. Throws, naming the one, when the agent cannot open it, or when there is no agent.
 */
export async function handedAs(
  programs: Pick<ExtensionPrograms, 'handedFiles' | 'handedChats'>,
  agent: string | undefined,
  tool: Tool | undefined,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<{ handed: ExtensionHandedFile[]; handedChats: ExtensionHandedChat[]; args: Record<string, unknown> | undefined }> {
  const ids = handedIds(tool, args, HANDED_FILE_FORMAT);
  const chatIds = handedIds(tool, args, HANDED_CHAT_FORMAT);
  if (ids.length === 0 && chatIds.length === 0) return { handed: [], handedChats: [], args };
  if (!agent) throw new Error(`${name} is handed a group ${ids.length > 0 ? 'file' : 'chat'}, and only an agent of that group can hand one`);
  const handed = ids.length > 0 ? await programs.handedFiles(agent, ids) : [];
  const handedChats = chatIds.length > 0 ? await programs.handedChats(agent, chatIds) : [];
  return { handed, handedChats, args: withHandedIds(tool, args, new Map(chatIds.map((id, index) => [id, handedChats[index]!.chatId]))) };
}

/** MCP Apps `_meta.ui.visibility`: who may call a tool. Absent means both. */
export function toolVisibleTo(tool: Tool, caller: 'model' | 'app'): boolean {
  const visibility = (tool._meta?.ui as { visibility?: unknown } | undefined)?.visibility;
  return !Array.isArray(visibility) || visibility.includes(caller);
}

/**
 * 摩擦单 F119 What programs give agents, as agents call it: `<App id>__<tool>`, whichever program gives it — one rule for
 * the catalog and app_check. A name two programs of one App give is theirs to rename: in `clashes`, never in `tools`.
 */
export function agentToolsOf<P extends { extensionId: string; server: string }>(listed: readonly { program: P; tools: readonly Tool[] }[]) {
  const givers = new Map<string, { program: P; tool: Tool }[]>();
  for (const { program, tools } of listed) {
    for (const tool of tools.filter((one) => toolVisibleTo(one, 'model'))) {
      const name = `${program.extensionId}__${tool.name}`;
      givers.set(name, [...(givers.get(name) ?? []), { program, tool }]);
    }
  }
  const all = [...givers];
  return {
    tools: all.filter(([, given]) => given.length === 1).map(([name, [given]]) => ({ name, ...given! })),
    clashes: all.filter(([, given]) => given.length > 1).map(([name, given]) => ({
      programs: given.map((one) => one.program),
      why: `${name} is given by programs ${given.map((one) => one.program.server).join(' and ')} of one App — rename one`,
    })),
  };
}

type ProgramNotificationListener = (extensionId: string, server: string, notification: Notification) => void;
const notificationListeners = new Set<ProgramNotificationListener>();

/** Every notification a program sends that the MCP client does not handle itself (progress, list changes). */
export function onExtensionProgramNotification(listener: ProgramNotificationListener): () => void {
  notificationListeners.add(listener);
  return () => void notificationListeners.delete(listener);
}

/** A native program's own notification (#7317), delivered as a stdio program's is: to the App's pages. */
export function notifyFromNativeProgram(program: Pick<ExtensionProgram, 'extensionId' | 'server'>, notification: Notification): void {
  for (const listener of notificationListeners) listener(program.extensionId, program.server, notification);
}

let programSource: () => ExtensionProgram[] = () => [];

/** An App program's process: the shared owned stdio transport, plus F16's surface when it runs on gugu's node. */
class ProgramTransport extends OwnedStdioTransport {
  /** F16 The program as a surface of its App (a program on gugu's node): its `gugu` is answered there. */
  surface: ProgramSurface | null = null;

  constructor(program: ExtensionProgram) {
    // F16 `gugu` in the program: gugu's runtime is imported before the App's code and talks to main over the fourth
    // stdio slot (Node IPC), never the program's stdin / stdout, which are its MCP server's.
    const runtime = () => (program.onGuguNode ? programRuntimePath() : null);
    super(() => {
      // The guide promises the program this folder; before, it existed only once a page had read or written data.
      fs.mkdirSync(program.dataDir, { recursive: true });
      const at = runtime();
      return {
        command: program.command,
        args: at ? ['--import', pathToFileURL(at).href, ...program.args] : program.args,
        cwd: program.cwd,
        env: program.env,
        ...(at ? { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] as const, serialization: 'advanced' as const } : {}),
      };
    }, {
      onSpawned: (child) => {
        if (program.onGuguNode) this.surface = attachProgramSurface(program.extensionId, child);
      },
      onClosed: () => {
        this.surface?.close();
        this.surface = null;
      },
    });
  }
}

interface Instance {
  /** The version key: an upgrade's calls look up the new version and never reach this one. */
  key: string;
  client: Client;
  transport: ProgramTransport;
  calls: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
  /** Settles once the program has exited: what an uninstall waits for before it takes the App's files. */
  gone: Promise<void>;
  exited: () => void;
}

const live = new Map<string, Instance>();
/** Every program that has not exited yet, versions an upgrade retired included. */
const instances = new Set<Instance>();
const starting = new Map<string, Promise<Instance>>();
/** Every program process not yet gone — starting, live or stopping; what a signal exit must kill. */
const spawned = new Set<ProgramTransport>();
/**
 * By version: the tools each program gave, and when its App's data last changed then. An App may keep its own settings in
 * its data folder (全能搜索's keys), written by its page, its program or an agent editing the file: a list kept from before
 * a change is asked again — from the running program, or one started for it (10-19: a key saved while it was stopped idle,
 * no tools until a restart).
 */
const toolLists = new Map<string, { tools: Tool[]; dataChanged: number }>();

/** The newest change anywhere under an App's data folder: any file's or folder's mtime (a removal changes its folder's); 0 when there is none. */
async function dataChangedAt(dir: string): Promise<number> {
  const gone = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (gone(error)) return 0;
    throw error;
  }
  const times = await Promise.all([dir, ...entries.map((entry) => `${entry.parentPath}/${entry.name}`)].map((at) =>
    fs.promises.stat(at).then((stat) => stat.mtimeMs, (error: unknown) => {
      if (gone(error)) return 0; // removed since it was read: its folder's mtime says so
      throw error;
    })));
  return Math.max(0, ...times);
}
const failures = new Map<string, ExtensionProgramFailure>();
const lastWorked = new Map<string, string>();
/** By version: the first sentence of what each program said at its last start (initialize `instructions`). */
const instructionsOf = new Map<string, string>();
const INSTRUCTIONS_MAX_CHARS = 200;

const keyOf = (program: ExtensionProgram) => `${program.extensionId}/${program.server}`;
/** What a program's tool list belongs to: one version of it. */
const versionKeyOf = (program: ExtensionProgram) => `${keyOf(program)}@${program.digest}`;

function recordFailure(program: ExtensionProgram, transport: ProgramTransport, error: string, notStarted: boolean): void {
  failures.set(program.extensionId, {
    server: program.server,
    at: new Date().toISOString(),
    said: lastStderrLine(transport.stderrTail) || null,
    notStarted,
    code: transport.owned?.child.exitCode ?? null,
    command: program.command,
    stderrTail: transport.stderrTail || error,
  });
}

function stop(instance: Instance): Promise<void> {
  instance.stopping = true;
  if (instance.idleTimer) clearTimeout(instance.idleTimer);
  if (live.get(instance.key) === instance) live.delete(instance.key);
  return instance.client.close().catch((error: unknown) =>
    log.warn('extension program did not stop cleanly', { key: instance.key, error: String(error) })).finally(() => {
    // Stopping takes the whole tree (OwnedStdioTransport.close), whether or not the client heard the close.
    instances.delete(instance);
    instance.exited();
  });
}

async function start(program: ExtensionProgram): Promise<Instance> {
  const key = versionKeyOf(program);
  const transport = new ProgramTransport(program);
  const client = new Client({ name: 'gugu', version: '1.0.0' });
  let exited!: () => void;
  const gone = new Promise<void>((resolve) => {
    exited = resolve;
  });
  const instance: Instance = { key, client, transport, calls: 0, idleTimer: null, stopping: false, gone, exited };
  instances.add(instance);
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void toolLists.delete(versionKeyOf(program)));
  client.fallbackNotificationHandler = async (notification) => {
    for (const listener of notificationListeners) listener(program.extensionId, program.server, notification);
  };
  spawned.add(transport);
  client.onclose = () => {
    spawned.delete(transport);
    instances.delete(instance);
    exited();
    if (live.get(key) !== instance) return;
    live.delete(key);
    if (!instance.stopping) recordFailure(program, transport, `exited with code ${transport.owned?.child.exitCode}`, false);
  };
  const startedAt = new Date().toISOString();
  instructionsOf.delete(key);
  try {
    await client.connect(transport);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const said = lastStderrLine(transport.stderrTail);
    recordFailure(program, transport, message, transport.owned?.child.pid === undefined);
    await transport.close().catch(() => undefined);
    spawned.delete(transport);
    instances.delete(instance);
    exited();
    // A program still running without an answer timed out; one that exited or never ran failed, in its own words when it said any.
    const why = error instanceof McpError && error.code === ErrorCode.RequestTimeout
      ? `timed out: it was running but did not answer within ${DEFAULT_REQUEST_TIMEOUT_MSEC / 1000} s${said ? `; it last said: ${said}` : ''}`
      : said ? `${said} (${message})` : message;
    throw new Error(`extension ${program.extensionId}: program ${program.server} did not start: ${why}`);
  }
  // A new process says its own tool list: one started on a changed config (an App's settings page) may give other tools
  // than the one before it, and is not obliged to say ToolListChanged about a list it never had.
  toolLists.delete(key);
  const said = firstSentence(client.getInstructions()?.replace(/\s+/g, ' ').trim() ?? '');
  if (said) instructionsOf.set(key, said.length > INSTRUCTIONS_MAX_CHARS ? `${said.slice(0, INSTRUCTIONS_MAX_CHARS)}…` : said);
  live.set(key, instance);
  lastWorked.set(program.extensionId, startedAt);
  return instance;
}

/** Out of the pool: no new calls reach it; it stops now if idle, else when its last call finishes. */
function retire(instance: Instance): void {
  if (live.get(instance.key) === instance) live.delete(instance.key);
  if (instance.calls === 0 && !instance.stopping) void stop(instance);
}

/**
 * An upgrade was installed, or the App uninstalled: its programs leave the pool — each stops now if idle (a chat file it
 * holds open does not keep it), else when its last call finishes. Settles once every one of them has exited.
 */
export async function retireExtensionPrograms(extensionId: string): Promise<void> {
  // Its settings in gugu changed, or it was upgraded: what its programs give is asked again.
  for (const key of [...toolLists.keys()]) if (key.startsWith(`${extensionId}/`)) toolLists.delete(key);
  const native = [...nativePrograms.values()].map((provider) => provider.retire(extensionId));
  const own = [...instances].filter((instance) => instance.key.startsWith(`${extensionId}/`));
  for (const instance of own) retire(instance);
  await Promise.all([...native, ...own.map((instance) => instance.gone)]);
}

/**
 * Idle is no call in flight and — F16 — no file held open: a program keeping a group file open (following it for
 * the agents it serves) is working even between calls, and stopping it would drop what it holds.
 */
function armIdle(instance: Instance): void {
  instance.idleTimer = setTimeout(() => {
    if (instance.calls > 0 || instance.stopping) return;
    if ((instance.transport.surface?.openFiles() ?? 0) > 0) armIdle(instance);
    else void stop(instance);
  }, IDLE_MS);
  instance.idleTimer.unref?.();
}

async function use<T>(program: ExtensionProgram, work: (client: Client) => Promise<T>,
  call?: { id: string; agent?: string; handed: readonly ExtensionHandedFile[]; handedChats: readonly ExtensionHandedChat[]; request?: ProgramRequestScope }): Promise<T> {
  const key = versionKeyOf(program);
  let pending = live.has(key) ? Promise.resolve(live.get(key)!) : starting.get(key);
  if (!pending) {
    pending = start(program).finally(() => starting.delete(key));
    starting.set(key, pending);
  }
  const instance = await pending;
  instance.calls += 1;
  if (instance.idleTimer) clearTimeout(instance.idleTimer);
  // The call's agent, and what it handed for this call only: taken back (and what was opened on it alone) when it ends.
  // The answer goes back to the agent once the program let go of them: its writes handed to the file service in order,
  // ahead of the Close — not yet confirmed by the service, a millisecond window no agent's next step reaches (F106).
  const release = call ? instance.transport.surface?.hand(call.id, call.agent ?? null, call.handed, call.handedChats, call.request) : undefined;
  try {
    return await work(instance.client);
  } finally {
    await release?.();
    instance.calls -= 1;
    if (instance.calls === 0 && !instance.stopping) {
      if (live.get(instance.key) !== instance) void stop(instance);
      else armIdle(instance);
    }
  }
}

export const extensionPrograms: ExtensionPrograms = {
  registerNative(name, provider) {
    nativePrograms.set(name, provider);
  },
  agentToolsRefusal(extensionId) {
    const service = extensionsService();
    try {
      service.get(extensionId);
      service.settings(extensionId);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    if (!service.isEnabled(extensionId)) return `Extension ${extensionId} is turned off`;
    if (!service.hasCapability(extensionId, 'agents:tools')) return `Extension ${extensionId} may no longer give agents tools`;
    return null;
  },
  async tools(program) {
    const dataChanged = await dataChangedAt(program.dataDir);
    const cached = toolLists.get(versionKeyOf(program));
    if (cached?.dataChanged === dataChanged) return cached.tools;
    const { tools } = program.native ? { tools: await nativeProgram(program).tools() } : await use(program, (client) => client.listTools());
    toolLists.set(versionKeyOf(program), { tools, dataChanged });
    return tools;
  },
  instructions(program) {
    return instructionsOf.get(versionKeyOf(program));
  },
  call(program, params, { signal, sessionId, onprogress, agent, handed = [], handedChats = [] }) {
    const id = randomUUID();
    const stamped = { ...params, _meta: { ...params._meta, [PROGRAM_CALL_META_KEY]: id } };
    const finished = (result: CallToolResult) => {
      if (result.isError) {
        const detail = result.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
        failures.set(program.extensionId, { kind: 'tool', server: program.server, at: new Date().toISOString(),
          said: detail, stderrTail: detail, notStarted: false, code: null, command: program.command });
      } else lastWorked.set(program.extensionId, new Date().toISOString());
      return result;
    };
    const perform = (lifetime: AbortSignal) => use(program,
      (client) => client.callTool(stamped, undefined, { signal: lifetime, onprogress, timeout: NO_TIMEOUT_MS }) as Promise<CallToolResult>,
      { id, agent, handed, handedChats, ...(sessionId ? { request: { sessionId, signal: lifetime } } : {}) }).then(finished);
    return program.native ? nativeProgram(program).call(program, stamped, signal).then(finished)
      : sessionId ? runHumanTool<CallToolResult>(sessionId, 'app_program', signal, perform, requestId => {
        const pending = humanToolPending(requestId);
        return { content: [{ type: 'text', text: JSON.stringify(pending) }], structuredContent: pending };
      }) : perform(signal);
  },
  handedFiles: handedFilesAs,
  handedChats: handedChatsAs,
  killAllSync() {
    for (const transport of spawned) transport.owned?.kill('SIGKILL');
  },
  setSource(source) {
    programSource = source;
  },
  installed() {
    return programSource();
  },
  async callFromPage(extensionId, { server, name, arguments: args, from }) {
    // The program runs only while the person lets this extension run programs at all.
    const refusal = extensionPrograms.agentToolsRefusal(extensionId);
    if (refusal) throw Object.assign(new Error(refusal), { code: 'denied' });
    const own = programSource().filter((program) => program.extensionId === extensionId);
    const program = server === undefined ? (own.length === 1 ? own[0] : undefined) : own.find((p) => p.server === server);
    if (!program) {
      throw Object.assign(new Error(server !== undefined ? `this App has no program named ${server}`
        : own.length === 0 ? 'this App has no MCP program' : `this App runs ${own.length} programs; name one`), { code: 'invalid' });
    }
    const tool = (await extensionPrograms.tools(program)).find((candidate) => candidate.name === name);
    if (!tool) throw Object.assign(new Error(`program ${program.server} has no tool ${name}`), { code: 'invalid' });
    if (!toolVisibleTo(tool, 'app')) throw Object.assign(new Error(`tool ${name} is for agents only (its _meta.ui.visibility has no "app")`), { code: 'invalid' });
    // Written here, never taken from the page: a page must not pass for an agent (`gugu/agent` is main's binding's).
    // A page has no harness to cancel for it: the MCP client's own default request timeout bounds the call.
    if (!('agent' in from)) {
      // A page in a session: the program is told that session and its working copy on this machine (`gugu/workspaceRoot`),
      // as an agent's call is — a page on another machine knows neither the path nor this machine's layout.
      const { agentSessionContext } = await import('./extension-agent-context');
      const root = from.sessionId ? (await agentSessionContext(from.sessionId))?.workspaceRoot : undefined;
      const _meta = {
        'gugu/caller': 'app',
        ...(from.sessionId ? { [SESSION_META_KEY]: from.sessionId } : {}),
        ...(root ? { [WORKSPACE_META_KEY]: root } : {}),
      };
      if (program.native) return extensionPrograms.call(program, { name, arguments: args, _meta }, { signal: new AbortController().signal });
      return use(program, (client) => client.callTool({ name, arguments: args, _meta }) as Promise<CallToolResult>);
    }
    // Worked by an agent (owner 10-14): its call, as the agent's own tool call is — stamped the same (its session, working
    // copy, model), what it hands checked as that agent, and what the program does in it done as that agent (`gugu/call`).
    const { agentSessionContext } = await import('./extension-agent-context');
    const stamp = await callerMeta({ agentId: from.agentSession, agentUserId: from.agent }, agentSessionContext);
    const given = await handedAs(extensionPrograms, from.agent.slice('user:'.length), tool, name, args);
    const id = randomUUID();
    const _meta = { 'gugu/caller': 'app', ...stamp, [PROGRAM_CALL_META_KEY]: id };
    if (program.native) return extensionPrograms.call(program, { name, arguments: given.args, _meta }, { signal: new AbortController().signal });
    return use(program, (client) => client.callTool({ name, arguments: given.args, _meta }) as Promise<CallToolResult>,
      { id, agent: from.agent.slice('user:'.length), handed: given.handed, handedChats: given.handedChats });
  },
};

/** What the extension panel shows: how many of its programs run now, and the last failure since one last worked. */
export function extensionProgramStatus(extensionId: string): ExtensionAgentStatus {
  const running = [...live.keys()].filter((key) => key.startsWith(`${extensionId}/`)).length;
  const failure = failures.get(extensionId) ?? null;
  const native = programSource().filter((program) => program.extensionId === extensionId && program.native)
    .map((program) => nativePrograms.get(program.native!)?.status(extensionId));
  const sessions = native.flatMap((status) => status?.sessions ?? []);
  return { running: running + native.reduce((sum, status) => sum + (status?.running ?? 0), 0),
    ...(native.length ? { sessions } : {}), lastFailure: failure && failure.at > (lastWorked.get(extensionId) ?? '') ? failure : null };
}

/** At quit: every program tree goes with gugu. */
export async function stopAllExtensionPrograms(): Promise<void> {
  await Promise.allSettled(starting.values());
  await Promise.allSettled([...live.values()].map(stop));
}
