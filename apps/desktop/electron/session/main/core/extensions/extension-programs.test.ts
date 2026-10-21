import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitFact } from '../../../../../../../tests/support/awaitFact';
import {
  callerMeta,
  extensionPrograms,
  extensionProgramStatus,
  onExtensionProgramNotification,
  retireExtensionPrograms,
  stopAllExtensionPrograms,
  toolVisibleTo,
  type ExtensionProgram,
} from './extension-programs';

const service = vi.hoisted(() => ({ installed: true, enabled: true, agentTools: true }));
vi.mock('@main/utils/userEnv', () => ({ loginShellEnv: () => null }));
vi.mock('@main/lib/logger', () => ({ log: { error: () => {}, warn: () => {}, info: () => {} } }));
/** The agent's session as main knows it: its working copy and the model gugu runs it on (`agentSessionContext`). */
const agentSession = vi.hoisted(() => ({ sessionId: 'task-f', projectId: 'p', workspaceRoot: '/work/f', model: 'gpt-6.1-sol' }));
vi.mock('./extension-agent-context', () => ({ agentSessionContext: async (id: string) => (id === 'task-f' ? agentSession : null) }));
vi.mock('./extensions-root', () => ({
  extensionsService: () => ({
    get: (id: string) => {
      if (!service.installed) throw new Error(`App not installed: ${id}`);
    },
    isEnabled: () => service.enabled,
    settings: () => ({}),
    hasCapability: (_id: string, capability: string) => capability === 'agents:tools' && service.agentTools,
  }),
}));

/**
 * #6615 gugu runs extension programs itself, one per program at the installed version, shared by every session. These start
 * a real (dependency-free) MCP program and read back what gugu and the program see.
 */

const FIXTURE = String.raw`
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [mode = '', log = ''] = process.argv.slice(2);
// config: what its one tool says is read once, at start — as a program reads the settings its page wrote.
const config = mode === 'config' ? readFileSync(log, 'utf8') : '';
if (mode === 'fail-at-start') {
  console.error('the client this program drives is not installed');
  process.exit(4);
}
if (mode === 'grandchild') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  appendFileSync(log, child.pid + '\n');
  setInterval(() => {}, 1000); // ignores stdin closing: only a tree kill ends it
}
let buffer = '';
let calls = 0;
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
    const message = JSON.parse(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
    if (message.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
    if (message.method === 'initialize') {
      if (mode === 'silent') continue; // running, never answering
      reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
        ...(mode === 'instructions' ? { instructions: '  No search service has a key:\n fill one in on the settings page. Then every tool is here. ' + 'x'.repeat(300) } : {}) });
    } else if (message.method === 'tools/list') {
      const tools = [{ name: 'whoami', inputSchema: { type: 'object' }, ...(config ? { description: config } : {}) }];
      if (mode === 'visibility') {
        tools.push({ name: 'page_only', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['app'] } } });
        tools.push({ name: 'agent_only', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['model'] } } });
      }
      reply({ tools });
    } else if (message.method === 'tools/call') {
      calls += 1;
      const held = mode === 'held' && calls > 1;
      if (mode === 'visibility' || held) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/fixture/called', params: { tool: message.params.name } }) + '\n');
      }
      if (mode === 'crash-on-call') {
        console.error('Error: fixture fell over');
        process.exit(3);
      }
      if (mode === 'write-data') writeFileSync(join(process.env.GUGU_EXTENSION_DATA_DIR, 'todos.json'), '[]');
      if (mode === 'tool-error' && calls === 1) { reply({ isError: true, content: [{ type: 'text', text: 'bootstrapTimedOut' }] }); continue; }
      const answer = () => reply({ content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, meta: message.params._meta ?? null, args: message.params.arguments ?? null,
        ...(mode === 'settings' ? { settings: JSON.parse(process.env.GUGU_APP_SETTINGS) } : {}) }) }] });
      // held: the second call is answered only once the case creates the gate file (the log argument).
      const whenReleased = () => (existsSync(log) ? answer() : setTimeout(whenReleased, 10));
      if (held) whenReleased();
      else answer();
    }
  }
});
process.stdin.on('end', () => { if (mode !== 'grandchild') process.exit(0); });
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-6615-programs-'));
const script = path.join(dir, 'server.mjs');
fs.writeFileSync(script, FIXTURE);

function program(extensionId: string, digest: string, mode = '', log = ''): ExtensionProgram {
  const dataDir = path.join(dir, 'data', extensionId);
  return {
    extensionId, server: extensionId, digest, command: process.execPath, args: [script, mode, log],
    env: { GUGU_EXTENSION_DATA_DIR: dataDir }, cwd: dir, dataDir,
  };
}

async function whoami(target: ExtensionProgram, agentId: string): Promise<{ pid: number; meta: Record<string, unknown> | null; settings?: Record<string, unknown> }> {
  const result = await extensionPrograms.call(
    target,
    { name: 'whoami', arguments: {}, _meta: { 'gugu/agent': agentId } },
    { signal: new AbortController().signal }
  );
  return JSON.parse((result.content[0] as { text: string }).text);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The process is gone. No deadline: a process that never exits is named by awaitFact's heartbeat, not a timer. */
const exited = (step: string, ...pids: number[]) =>
  awaitFact(step, () => (pids.some(alive) ? undefined : true));

afterEach(async () => {
  await stopAllExtensionPrograms();
});

describe('extension programs run by gugu (#6615)', () => {
  it('shows a real MCP tool failure even while the native client process is running, and clears it after a successful call', async () => {
    const target = program('desktop-client', 'v1', 'tool-error');
    const call = () => extensionPrograms.call(target, { name: 'whoami' }, { signal: new AbortController().signal });
    expect((await call()).isError).toBe(true);
    expect(extensionProgramStatus('desktop-client')).toMatchObject({ running: 1, lastFailure: { kind: 'tool', stderrTail: 'bootstrapTimedOut' } });
    expect((await call()).isError).not.toBe(true);
    expect(extensionProgramStatus('desktop-client').lastFailure).toBeNull();
  });
  it('real MCP calls read the new settings in a new process after configuration is saved', async () => {
    const before = { ...program('settings-reader', 'config-1', 'settings'), env: { GUGU_APP_SETTINGS: '{"account":"personal"}' } };
    const first = await whoami(before, 'user:a');
    expect(first.settings).toEqual({ account: 'personal' });
    void retireExtensionPrograms('settings-reader');
    const after = { ...before, digest: 'config-2', env: { GUGU_APP_SETTINGS: '{"account":"work"}' } };
    const second = await whoami(after, 'user:a');
    expect(second.settings).toEqual({ account: 'work' });
    expect(second.pid).not.toBe(first.pid);
    await exited('old configuration process exits', first.pid);
  });
  it('two sessions share one process and each call carries its own caller', async () => {
    const notes = program('agent-notes', 'v1');
    expect((await extensionPrograms.tools(notes)).map((tool) => tool.name)).toEqual(['whoami']);
    const a = await whoami(notes, 'user:a');
    const b = await whoami(notes, 'user:b');
    expect(b.pid).toBe(a.pid);
    expect([a.meta?.['gugu/agent'], b.meta?.['gugu/agent']]).toEqual(['user:a', 'user:b']);
    // Each call its own id, minted here: what the program's verbs in that call carry back (program-call.ts).
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect([a.meta?.['gugu/call'], b.meta?.['gugu/call']]).toEqual([expect.stringMatching(UUID), expect.stringMatching(UUID)]);
    expect(b.meta?.['gugu/call']).not.toBe(a.meta?.['gugu/call']);
    expect(extensionProgramStatus('agent-notes')).toEqual({ running: 1, lastFailure: null });
    // An upgrade is installed: the old version leaves the pool and the next call, from any session, runs the new one.
    void retireExtensionPrograms('agent-notes');
    expect((await whoami(program('agent-notes', 'v2'), 'conv-a')).pid).not.toBe(a.pid);
    expect(extensionProgramStatus('agent-notes').running).toBe(1);
    await exited('the retired version exits', a.pid);
  }, 30_000);

  it('installing an upgrade retires the running version: idle at once, busy once its call is answered', async () => {
    const idle = await whoami(program('idle', 'v1'), 'conv-a');
    const release = path.join(dir, 'busy-release');
    const busy = program('busy', 'v1', 'held', release);
    const first = await whoami(busy, 'conv-a');
    // The program says so the moment it has the second call; it answers only once `release` exists.
    const holding = new Promise<void>((resolve) => {
      const off = onExtensionProgramNotification((extensionId) => {
        if (extensionId !== 'busy') return;
        off();
        resolve();
      });
    });
    const inFlight = whoami(busy, 'conv-b');
    await holding;
    void retireExtensionPrograms('idle');
    void retireExtensionPrograms('busy');
    await exited('the idle program exits at once', idle.pid);
    expect(alive(first.pid)).toBe(true);
    fs.writeFileSync(release, '');
    expect((await inFlight).pid).toBe(first.pid);
    await exited('the busy program exits once its call is answered', first.pid);
    expect([extensionProgramStatus('idle').running, extensionProgramStatus('busy').running]).toEqual([0, 0]);
  }, 30_000);

  it('an uninstall waits on its programs: retiring settles once each has exited, a busy one after its call (10-06)', async () => {
    const idle = await whoami(program('gone-idle', 'v1'), 'conv-a');
    await retireExtensionPrograms('gone-idle');
    expect(alive(idle.pid)).toBe(false);

    const release = path.join(dir, 'gone-busy-release');
    const busy = program('gone-busy', 'v1', 'held', release);
    const first = await whoami(busy, 'conv-a');
    const holding = new Promise<void>((resolve) => {
      const off = onExtensionProgramNotification((extensionId) => {
        if (extensionId !== 'gone-busy') return;
        off();
        resolve();
      });
    });
    const inFlight = whoami(busy, 'conv-b');
    await holding;
    const retired = retireExtensionPrograms('gone-busy');
    fs.writeFileSync(release, '');
    expect((await inFlight).pid).toBe(first.pid);
    await retired;
    expect(alive(first.pid)).toBe(false);
  }, 30_000);

  it.skipIf(process.platform === 'win32')('a command found on PATH starts: the program has the host PATH (10-06)', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-path-bin-'));
    // Found by its bare name, as `npx` is; the fixture itself is the program.
    const probe = `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(script).href)})\n`;
    fs.writeFileSync(path.join(bin, 'gugu-path-probe'), probe, { mode: 0o755 });
    const before = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${before ?? ''}`;
    try {
      const onPath = { ...program('on-path', 'v1'), command: 'gugu-path-probe', args: [] };
      expect((await whoami(onPath, 'conv-a')).pid).toBeGreaterThan(0);
    } finally {
      process.env.PATH = before;
    }
  }, 30_000);

  it('stopping takes the whole tree, even a program that ignores stdin closing', async () => {
    const log = path.join(dir, 'grandchild.log');
    const { pid } = await whoami(program('tree', 'v1', 'grandchild', log), 'conv-a');
    const grandchild = Number(fs.readFileSync(log, 'utf8').trim());
    expect([alive(pid), alive(grandchild)]).toEqual([true, true]);
    await stopAllExtensionPrograms();
    await exited('the program and its grandchild are gone', pid, grandchild);
    expect(extensionProgramStatus('tree')).toEqual({ running: 0, lastFailure: null });
  }, 30_000);

  it('a signal exit kills the whole tree synchronously', async () => {
    const log = path.join(dir, 'grandchild-sync.log');
    const { pid } = await whoami(program('tree-sync', 'v1', 'grandchild', log), 'conv-a');
    const grandchild = Number(fs.readFileSync(log, 'utf8').trim());
    extensionPrograms.killAllSync();
    await exited('the program and its grandchild are gone', pid, grandchild);
  }, 30_000);

  it('a program that cannot start, or falls over, is seen with its own words until one works', async () => {
    const missing = { ...program('broken', 'v1'), command: path.join(dir, 'no-such-program') };
    await expect(whoami(missing, 'conv-a')).rejects.toThrow(/did not start/);
    expect(extensionProgramStatus('broken').lastFailure).toMatchObject({ notStarted: true, server: 'broken' });

    await expect(whoami(program('broken', 'v2', 'crash-on-call'), 'conv-a')).rejects.toThrow();
    // The crash is recorded when the process closes — its stderr is read to the end by then.
    const crash = await awaitFact('the crash is recorded', () => {
      const failure = extensionProgramStatus('broken').lastFailure;
      return failure && !failure.notStarted ? failure : undefined;
    });
    expect(crash).toMatchObject({ notStarted: false, code: 3, said: 'Error: fixture fell over' });

    await whoami(program('broken', 'v3'), 'conv-a');
    expect(extensionProgramStatus('broken').lastFailure).toBeNull();
  }, 30_000);

  // 10-19 mac1: a program that failed said why, and the catalog said only "Request timed out"; one that never answers is another case.
  it('a program that exits before answering fails in its own words; one running without an answer timed out', async () => {
    await expect(whoami(program('says-why', 'v1', 'fail-at-start'), 'conv-a'))
      .rejects.toThrow(/program says-why did not start: the client this program drives is not installed \(MCP error -32000: Connection closed\)$/);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled: Error | undefined;
      void whoami(program('silent', 'v1', 'silent'), 'conv-a').catch((error: Error) => (settled = error));
      while (!settled) {
        await new Promise((resolve) => setImmediate(resolve)); // the program's real I/O
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(settled.message).toMatch(/program silent did not start: timed out: it was running but did not answer within 60 s$/);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  // 10-19: a program that gives agents nothing says why in initialize's instructions; only its first sentence is kept.
  it('keeps the first sentence of what a program says about itself at its start, and nothing for one that says nothing', async () => {
    const says = program('says', 'v1', 'instructions');
    await extensionPrograms.tools(says);
    expect(extensionPrograms.instructions(says)).toBe('No search service has a key: fill one in on the settings page.');
    const quiet = program('quiet', 'v1');
    await extensionPrograms.tools(quiet);
    expect(extensionPrograms.instructions(quiet)).toBeUndefined();
  }, 30_000);

  // Dogfood (125, omnisearch 10-06): the program stopped idle and started on the settings its page had changed; agents
  // still got the list of the process before it, kept for the version until a ToolListChanged that never came.
  // 10-19: 全能搜索 stopped idle; its page saved a key; agents saw no tools until gugu restarted — the list was its old one.
  // Edited in place (an agent's editor, the App's page through gugu, the program itself): the folder's own mtime does not move.
  it('a program stopped idle whose settings in its data folder then changed: the next listing asks again, starting it', async () => {
    const searcher = program('idle-searcher', 'v1', 'config');
    fs.mkdirSync(path.join(searcher.dataDir, 'conf'), { recursive: true });
    const settings = path.join(searcher.dataDir, 'conf', 'settings.txt');
    fs.writeFileSync(settings, 'searches with: none');
    searcher.args = [script, 'config', settings];
    expect((await extensionPrograms.tools(searcher)).map((tool) => tool.description)).toEqual(['searches with: none']);
    await stopAllExtensionPrograms();
    const folderBefore = fs.statSync(path.dirname(settings)).mtimeMs;
    fs.writeFileSync(settings, 'searches with: firecrawl');
    const later = new Date(Date.now() + 2_000);
    fs.utimesSync(settings, later, later);
    expect(fs.statSync(path.dirname(settings)).mtimeMs).toBe(folderBefore);
    expect((await extensionPrograms.tools(searcher)).map((tool) => tool.description)).toEqual(['searches with: firecrawl']);
    // Unchanged since: the kept list, no program started for it.
    await stopAllExtensionPrograms();
    fs.writeFileSync(settings, 'searches with: something else');
    fs.utimesSync(settings, later, later);
    expect((await extensionPrograms.tools(searcher)).map((tool) => tool.description)).toEqual(['searches with: firecrawl']);
  }, 30_000);

  it('retiring an App (its settings changed in gugu, an upgrade) forgets its tool lists too', async () => {
    const settings = path.join(dir, 'settings-retire.txt');
    fs.writeFileSync(settings, 'searches with: none');
    const searcher = program('retired-searcher', 'v1', 'config', settings);
    await extensionPrograms.tools(searcher);
    await stopAllExtensionPrograms();
    fs.writeFileSync(settings, 'searches with: exa');
    await retireExtensionPrograms('retired-searcher');
    expect((await extensionPrograms.tools(searcher)).map((tool) => tool.description)).toEqual(['searches with: exa']);
  }, 30_000);

  it("a program started anew says its own tool list, not the one before it", async () => {
    const settings = path.join(dir, 'settings.txt');
    fs.writeFileSync(settings, 'searches with: none');
    const searcher = program('searcher', 'v1', 'config', settings);
    expect((await extensionPrograms.tools(searcher)).map((tool) => tool.description)).toEqual(['searches with: none']);
    await stopAllExtensionPrograms();
    fs.writeFileSync(settings, 'searches with: tavily');
    await whoami(searcher, 'conv-a');
    expect((await extensionPrograms.tools(searcher)).map((tool) => tool.description)).toEqual(['searches with: tavily']);
  }, 30_000);

  it('whether agents may use it is read now: uninstalled, switched off and revoked each say why', () => {
    const refusals: (string | null)[] = [];
    refusals.push(extensionPrograms.agentToolsRefusal('agent-notes'));
    service.agentTools = false;
    refusals.push(extensionPrograms.agentToolsRefusal('agent-notes'));
    service.enabled = false;
    refusals.push(extensionPrograms.agentToolsRefusal('agent-notes'));
    service.installed = false;
    refusals.push(extensionPrograms.agentToolsRefusal('agent-notes'));
    expect(refusals).toEqual([
      null,
      'Extension agent-notes may no longer give agents tools',
      'Extension agent-notes is turned off',
      'App not installed: agent-notes',
    ]);
    Object.assign(service, { installed: true, enabled: true, agentTools: true });
  });
});

describe("an extension's own pages call its programs (#6635)", () => {
  const page = program('page-ext', 'v1', 'visibility');
  extensionPrograms.setSource(() => [page]);
  const fromPage = (name: string, args: Record<string, unknown> = {}) =>
    extensionPrograms.callFromPage('page-ext', { name, arguments: args, from: { sessionId: 'task-1' } });

  it('MCP Apps visibility: absent means both, otherwise only the callers it names', () => {
    const tool = (visibility?: string[]) => ({ name: 't', inputSchema: { type: 'object' as const }, ...(visibility ? { _meta: { ui: { visibility } } } : {}) });
    expect([toolVisibleTo(tool(), 'model'), toolVisibleTo(tool(), 'app')]).toEqual([true, true]);
    expect([toolVisibleTo(tool(['app']), 'model'), toolVisibleTo(tool(['app']), 'app')]).toEqual([false, true]);
    expect([toolVisibleTo(tool(['model']), 'model'), toolVisibleTo(tool(['model']), 'app')]).toEqual([true, false]);
  });

  it("reaches the process its sessions use, with the host's _meta, never one the page wrote", async () => {
    const agent = await whoami(page, 'user:a');
    const result = await fromPage('whoami', { _meta: { 'gugu/agent': 'user:forged' } });
    const seen = JSON.parse((result.content[0] as { text: string }).text);
    expect(seen.pid).toBe(agent.pid);
    // The page's own: never an agent id, and no session of it either (an App names agents by user:<uuid>).
    expect(seen.meta).toEqual({ 'gugu/caller': 'app', 'gugu/sessionId': 'task-1' });
    expect(seen.args).toEqual({ _meta: { 'gugu/agent': 'user:forged' } });
  }, 30_000);

  // owner 10-16: a page's program may run on another machine than the page; it is told its session's working copy where
  // it runs, as an agent's call is. Mutation: a page stamp without `gugu/workspaceRoot` fails here.
  it("tells the program the page's session and its working copy on this machine", async () => {
    const result = await extensionPrograms.callFromPage('page-ext', { name: 'whoami', from: { sessionId: 'task-f' } });
    expect(JSON.parse((result.content[0] as { text: string }).text).meta).toEqual({
      'gugu/caller': 'app', 'gugu/sessionId': 'task-f', 'gugu/workspaceRoot': '/work/f',
    });
  }, 30_000);

  // Owner 10-14, review 83fad65916: a page an agent works calls as that agent — stamped exactly as the agent's own tool
  // call is (its agent, session, working copy, model: `callerMeta`, the gateway's), with `gugu/caller: app` and a call id of
  // its own; the host says who, the page never does. Mutation: a page stamp without `gugu/model` fails here.
  it('worked by an agent: stamped key by key as the agent\'s own call, from the app, with a call id of its own', async () => {
    const agent = 'user:0a000000-0000-4000-8000-0000000000f1';
    const own = await callerMeta({ agentId: 'task-f', agentUserId: agent }, async (id) => (id === 'task-f' ? agentSession : null));
    const viaAgent = await extensionPrograms.call(page, { name: 'whoami', arguments: {}, _meta: own }, { signal: new AbortController().signal });
    const viaPage = await extensionPrograms.callFromPage('page-ext', { name: 'whoami', from: { agent, agentSession: 'task-f' } });
    const stampOf = (result: { content: unknown[] }) => JSON.parse((result.content[0] as { text: string }).text).meta as Record<string, unknown>;
    const { 'gugu/call': agentCall, ...agentStamp } = stampOf(viaAgent);
    const { 'gugu/call': pageCall, 'gugu/caller': from, ...pageStamp } = stampOf(viaPage);
    expect(agentStamp).toEqual({ 'gugu/agent': agent, 'gugu/sessionId': 'task-f', 'gugu/workspaceRoot': '/work/f', 'gugu/model': 'gpt-6.1-sol' });
    expect(pageStamp).toEqual(agentStamp);
    expect(from).toBe('app');
    expect([agentCall, pageCall]).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/), expect.stringMatching(/^[0-9a-f-]{36}$/)]);
    expect(pageCall).not.toBe(agentCall);
  }, 30_000);

  it("calls tools visible to app and refuses the agents' own, unknown tools, and a program it may not run", async () => {
    await expect(fromPage('page_only')).resolves.toMatchObject({ content: [{ type: 'text' }] });
    // 复核 #7300 要改 3: each refusal carries the code a page branches on — the one the other machine passes on too.
    await expect(fromPage('agent_only')).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('tool agent_only is for agents only') });
    await expect(fromPage('nope')).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('program page-ext has no tool nope') });
    await expect(extensionPrograms.callFromPage('other', { name: 'whoami', from: {} })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('this App has no MCP program') });
    service.agentTools = false;
    await expect(fromPage('page_only')).rejects.toMatchObject({ code: 'denied', message: expect.stringContaining('Extension page-ext may no longer give agents tools') });
    service.agentTools = true;
  }, 30_000);

  it('hands every notification the program sends to listeners, with its extension and program', async () => {
    const heard: unknown[] = [];
    const off = onExtensionProgramNotification((extensionId, server, notification) => heard.push({ extensionId, server, notification }));
    await fromPage('page_only');
    off();
    expect(heard).toEqual([{
      extensionId: 'page-ext',
      server: 'page-ext',
      notification: expect.objectContaining({ method: 'notifications/fixture/called', params: { tool: 'page_only' } }),
    }]);
  }, 30_000);
});

// W-21: a program's first write into GUGU_EXTENSION_DATA_DIR hit ENOENT: only a page's readData/writeData made the folder.
describe('a program finds its data folder (#6634 问题 14)', () => {
  it('the data folder exists before the program starts, so its first write lands', async () => {
    const target = program('first-write', 'v1', 'write-data');
    expect(fs.existsSync(target.dataDir)).toBe(false);
    await whoami(target, 'conv-a');
    expect(JSON.parse(fs.readFileSync(path.join(target.dataDir, 'todos.json'), 'utf8'))).toEqual([]);
  });
});
