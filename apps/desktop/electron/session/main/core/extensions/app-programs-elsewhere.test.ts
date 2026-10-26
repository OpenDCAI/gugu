import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A page's calls that follow its session's machine (its program, its data folder; owner 10-16) are done where its session
 * is, in one action (`app_call`). The machine that has the session does them as a page's call made there — its install,
 * switch, `agents:tools` — only for the same version of the App, and a call sent again after a lost answer joins the
 * first instead of being done twice. The asking machine finds the session in the other machines' lists and passes their
 * refusals on with the codes a page branches on.
 */
const installed = vi.hoisted(() => ({ version: '0.7.0' as string | null, refusal: null as string | null, enabled: true, servers: [{ tools: 'tools.js' }] as Record<string, string>[] }));
// This machine's data folders: a real one per test (the page's own verbs read and write it, and uploads land in it).
const folder = vi.hoisted(() => ({ root: '' }));
const callFromPage = vi.hoisted(() => vi.fn());
const appCall = vi.hoisted(() => vi.fn());
const sessionsElsewhere = vi.hoisted(() => vi.fn());
vi.mock('@main/lib/logger', () => ({ log: { warn: () => undefined, error: () => undefined, info: () => undefined } }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    get: () => {
      if (!installed.version) throw new Error('Extension spexcode is not installed');
      return { manifest: { name: 'SpexCode', version: installed.version, contributes: { tabs: [], mcpServers: installed.servers } } };
    },
    isEnabled: () => installed.enabled,
    hasCapability: () => true,
  }),
  extensionDataRoot: (id: string) => join(folder.root, id),
}));
vi.mock('@main/core/extensions/extension-programs', () => ({
  extensionPrograms: { agentToolsRefusal: () => installed.refusal, callFromPage },
}));
// This computer has one session; the others are on other machines or nowhere.
vi.mock('@main/core/extensions/extension-agent-context', () => ({
  agentSessionContext: async (sessionId: string) => (sessionId === 's-here' ? { sessionId, projectId: 'p-1', workspaceRoot: '/repo' } : null),
}));
vi.mock('@main/core/extensions/extension-agents', () => ({ sessionsElsewhere }));
vi.mock('@main/core/sessions/session-family', () => ({ otherMachines: () => ({ appCall, isThisDevice: async (id: string) => id === 'dev-here' }) }));
const elsewhere = await import('./app-programs-elsewhere');

const CALLER = { kind: 'app', deviceId: 'dev-a', deviceLabel: 'laptop', extensionId: 'spexcode', extensionName: 'SpexCode' } as const;
const action = (overrides: Record<string, unknown> = {}, args: Record<string, unknown> = { name: 'graph', arguments: { root: '/x' } }) => ({
  action: 'app_call' as const, call_id: 'c-1', session_id: 's-here', version: '0.7.0', method: 'callProgram', args, ...overrides,
});
const data = (method: 'readData' | 'writeData' | 'listData', args: Record<string, unknown>, callId: string) => action({ call_id: callId, method }, args);
const MB = 1024 * 1024;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message }));
const OK = { content: [{ type: 'text', text: '{"nodes":[]}' }] };

beforeEach(() => {
  installed.version = '0.7.0';
  installed.refusal = null;
  installed.enabled = true;
  installed.servers = [{ tools: 'tools.js' }];
  folder.root = mkdtempSync(join(tmpdir(), 'appprog-data-'));
  callFromPage.mockReset();
  appCall.mockReset();
  sessionsElsewhere.mockReset();
});
afterEach(() => rmSync(folder.root, { recursive: true, force: true }));

it('the verbs done on the session machine are the table rows that say machine, each with its one implementation', async () => {
  const { BRIDGE_VERBS } = await import('@shared/extensions/bridge-protocol');
  const { machineVerbs } = await import('./machine-verbs');
  const rows = Object.entries(BRIDGE_VERBS).filter(([, facts]) => 'machine' in facts && facts.machine).map(([verb]) => verb);
  expect(Object.keys(machineVerbs).sort()).toEqual(rows.sort());
  expect(rows.length).toBeGreaterThan(0);
});

describe('the machine that has the session does the call', () => {
  it('calls a selected machine without finding or manufacturing a session', async () => {
    appCall.mockResolvedValue(OK);
    const app = { extensionId: 'spexcode', manifest: { name: 'SpexCode', version: '0.7.0', contributes: { tabs: [], mcpServers: [{ tools: 'tools.js' }] } } };
    expect(await elsewhere.callOnSessionMachine(app as Parameters<typeof elsewhere.callOnSessionMachine>[0], { deviceId: 'dev-there' }, 'callProgram', { name: 'graph' }, false)).toEqual({ there: true, value: OK });
    const sent = appCall.mock.calls[0]![2];
    expect(sent).toMatchObject({ device_id: 'dev-there', method: 'callProgram' });
    expect(sent).not.toHaveProperty('session_id');
    expect(sessionsElsewhere).not.toHaveBeenCalled();
    expect(await elsewhere.callOnSessionMachine(app as Parameters<typeof elsewhere.callOnSessionMachine>[0], { deviceId: 'dev-here' }, 'callProgram', {}, false)).toEqual({ there: false });
    callFromPage.mockResolvedValue(OK);
    expect(await elsewhere.answerAppCall(CALLER, { ...action(), session_id: undefined, device_id: 'dev-here', call_id: 'device-answer' })).toEqual(OK);
    expect(callFromPage).toHaveBeenCalledWith('spexcode', expect.objectContaining({ from: {} }));
  });
  it('runs a program call as a page call made here, for that session', async () => {
    callFromPage.mockResolvedValue(OK);
    expect(await elsewhere.answerAppCall(CALLER, action({ call_id: 'run-1' }))).toEqual(OK);
    expect(callFromPage).toHaveBeenCalledWith('spexcode', { name: 'graph', arguments: { root: '/x' }, from: { sessionId: 's-here' } });
  });

  it('refuses with the code a page branches on: not installed, another version, switched off, not this machine\'s session', async () => {
    installed.version = null;
    expect(await refusal(elsewhere.answerAppCall(CALLER, action({ call_id: 'r-1' })))).toMatchObject({ code: 'not-installed' });
    installed.version = '0.6.0';
    expect(await refusal(elsewhere.answerAppCall(CALLER, action({ call_id: 'r-2' })))).toEqual({
      code: 'version-mismatch',
      message: 'SpexCode is 0.6.0 on this machine and 0.7.0 where its page is; install the same version on both',
    });
    installed.version = '0.7.0';
    installed.refusal = 'Extension spexcode is turned off';
    expect(await refusal(elsewhere.answerAppCall(CALLER, action({ call_id: 'r-3' })))).toEqual({ code: 'denied', message: 'Extension spexcode is turned off' });
    installed.refusal = null;
    expect(await refusal(elsewhere.answerAppCall(CALLER, action({ call_id: 'r-4', session_id: 's-gone' })))).toMatchObject({ code: 'not-found' });
    expect(callFromPage).not.toHaveBeenCalled();
  });

  it('does only a verb whose row follows the session\'s machine — never a program gugu hosts (161 10-17), never any other verb', async () => {
    installed.servers = [{ name: 'browser', host: 'browser-use' }];
    expect(await refusal(elsewhere.answerAppCall(CALLER, action({ call_id: 'hosted' }, { name: 'open' })))).toMatchObject({ code: 'invalid' });
    installed.servers = [{ tools: 'tools.js' }];
    expect(await refusal(elsewhere.answerAppCall(CALLER, action({ call_id: 'other', method: 'notify' }, { title: 'x' })))).toMatchObject({
      code: 'invalid', message: 'notify is done where the page is, not on its session\'s machine',
    });
    expect(await refusal(elsewhere.answerAppCall(CALLER, action({ call_id: 'unknown', method: 'nope' }, {})))).toMatchObject({ code: 'invalid' });
    expect(callFromPage).not.toHaveBeenCalled();
  });

  it('a call sent again after the first finished gets that answer: it was done once', async () => {
    callFromPage.mockResolvedValue(OK);
    expect(await elsewhere.answerAppCall(CALLER, action({ call_id: 'seq' }), 1_000)).toEqual(OK);
    expect(await elsewhere.answerAppCall(CALLER, action({ call_id: 'seq' }), 2_000)).toEqual(OK);
    expect(callFromPage).toHaveBeenCalledTimes(1);
  });

  it('keeps only the newest answers: the oldest of more than it keeps is done again', async () => {
    callFromPage.mockResolvedValue(OK);
    for (let i = 0; i <= elsewhere.APP_CALLS_KEPT; i += 1) await elsewhere.answerAppCall(CALLER, action({ call_id: `many-${i}` }), 1_000);
    expect(callFromPage).toHaveBeenCalledTimes(elsewhere.APP_CALLS_KEPT + 1);
    await elsewhere.answerAppCall(CALLER, action({ call_id: `many-${elsewhere.APP_CALLS_KEPT}` }), 1_000);
    expect(callFromPage).toHaveBeenCalledTimes(elsewhere.APP_CALLS_KEPT + 1);
    await elsewhere.answerAppCall(CALLER, action({ call_id: 'many-0' }), 1_000);
    expect(callFromPage).toHaveBeenCalledTimes(elsewhere.APP_CALLS_KEPT + 2);
  });

  it('a failure after the call was reached is that call\'s: sent again, it is not done again (复核 #7300 建议 1)', async () => {
    callFromPage.mockRejectedValueOnce(Object.assign(new Error('MCP error -32001: Request timed out'), { code: 'failed' }));
    expect(await refusal(elsewhere.answerAppCall(CALLER, action({ call_id: 'slow' }), 1_000))).toMatchObject({ code: 'failed' });
    expect(await refusal(elsewhere.answerAppCall(CALLER, action({ call_id: 'slow' }), 2_000))).toMatchObject({ code: 'failed' });
    callFromPage.mockResolvedValueOnce({ content: [{ type: 'text', text: 'x'.repeat(MB) }] });
    expect(await refusal(elsewhere.answerAppCall(CALLER, action({ call_id: 'huge' }), 3_000))).toMatchObject({ code: 'too-large' });
    expect(await refusal(elsewhere.answerAppCall(CALLER, action({ call_id: 'huge' }), 4_000))).toMatchObject({ code: 'too-large' });
    expect(callFromPage).toHaveBeenCalledTimes(2);
  });

  it('joins a call sent again to its first, while it runs and after — and decides a refused one again', async () => {
    let finish!: (value: unknown) => void;
    callFromPage.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const first = elsewhere.answerAppCall(CALLER, action({ call_id: 'twice' }), 1_000);
    const again = elsewhere.answerAppCall(CALLER, action({ call_id: 'twice' }), 1_500);
    await Promise.resolve();
    finish(OK);
    expect(await first).toEqual(OK);
    expect(await again).toEqual(OK);
    expect(await elsewhere.answerAppCall(CALLER, action({ call_id: 'twice' }), 1_000 + elsewhere.APP_CALL_KEPT_MS - 1)).toEqual(OK);
    expect(callFromPage).toHaveBeenCalledTimes(1);
    // Kept no longer than that, and kept per asking machine.
    callFromPage.mockResolvedValue(OK);
    await elsewhere.answerAppCall(CALLER, action({ call_id: 'twice' }), 1_000 + elsewhere.APP_CALL_KEPT_MS + 1);
    await elsewhere.answerAppCall({ ...CALLER, deviceId: 'dev-b' }, action({ call_id: 'twice' }), 2_000);
    expect(callFromPage).toHaveBeenCalledTimes(3);
    installed.version = null;
    expect(await refusal(elsewhere.answerAppCall(CALLER, action({ call_id: 'later' }), 5_000))).toMatchObject({ code: 'not-installed' });
    installed.version = '0.7.0';
    expect(await elsewhere.answerAppCall(CALLER, action({ call_id: 'later' }), 5_001)).toEqual(OK);
  });

  it('refuses an answer over 1 MB of UTF-8 whole, never cut — counted in bytes, not characters', async () => {
    const chars = Math.floor(MB / 3) + 10; // under the cap in characters, over it in bytes
    callFromPage.mockResolvedValue({ content: [{ type: 'text', text: '规'.repeat(chars) }] });
    expect(await refusal(elsewhere.answerAppCall(CALLER, action({ call_id: 'big' })))).toMatchObject({ code: 'too-large' });
  });
});

describe('the machine that has the session keeps the App\'s data (161 10-16「地方决定机器」)', () => {
  it('reads, writes and lists this App\'s data folder here — the one its program uses — with the verbs a page here calls', async () => {
    expect(await elsewhere.answerAppCall(CALLER, data('readData', { path: 'journal.json' }, 'd-1'))).toBeNull();
    expect(await elsewhere.answerAppCall(CALLER, data('writeData', { path: 'journal.json', content: '{"days":{}}' }, 'd-2'))).toBeUndefined();
    expect(readFileSync(join(folder.root, 'spexcode', 'journal.json'), 'utf8')).toBe('{"days":{}}');
    expect(await elsewhere.answerAppCall(CALLER, data('readData', { path: 'journal.json' }, 'd-3'))).toBe('{"days":{}}');
    expect(await elsewhere.answerAppCall(CALLER, data('listData', { path: '.' }, 'd-4'))).toEqual([{ path: 'journal.json', kind: 'file' }]);
    expect(await refusal(elsewhere.answerAppCall(CALLER, data('readData', { path: '../escape.json' }, 'd-5')))).toMatchObject({ code: 'invalid' });
  });

  it('takes only a file inside the data folder, as a page here does — never the folder, an absolute path, or a file left outside (复核追记 2)', async () => {
    mkdirSync(join(folder.root, 'spexcode'), { recursive: true });
    for (const bad of ['', '.', join(folder.root, 'spexcode', 'abs.json')]) {
      expect(await refusal(elsewhere.answerAppCall(CALLER, data('writeData', { path: bad, content: '{}' }, `w-${bad.length}`)))).toMatchObject({ code: 'invalid' });
      expect(await refusal(elsewhere.answerAppCall(CALLER, data('readData', { path: bad }, `r-${bad.length}`)))).toMatchObject({ code: 'invalid' });
    }
    expect(readdirSync(folder.root)).toEqual(['spexcode']);
    expect(readdirSync(join(folder.root, 'spexcode'))).toEqual([]);
  });

  it('refuses as a program call does — not installed, another version, switched off, not this machine\'s session — but asks no capability', async () => {
    const read = (callId: string, overrides: Record<string, unknown> = {}) => action({ call_id: callId, method: 'readData', ...overrides }, { path: 'journal.json' });
    installed.version = null;
    expect(await refusal(elsewhere.answerAppCall(CALLER, read('n-1')))).toMatchObject({ code: 'not-installed' });
    installed.version = '0.6.0';
    expect(await refusal(elsewhere.answerAppCall(CALLER, read('n-2')))).toMatchObject({ code: 'version-mismatch' });
    installed.version = '0.7.0';
    installed.enabled = false;
    expect(await refusal(elsewhere.answerAppCall(CALLER, read('n-3')))).toEqual({ code: 'denied', message: 'Extension spexcode is turned off' });
    installed.enabled = true;
    expect(await refusal(elsewhere.answerAppCall(CALLER, read('n-4', { session_id: 's-gone' })))).toMatchObject({ code: 'not-found' });
    // Giving agents tools is the program's grant, not the data's.
    installed.refusal = 'Extension spexcode may no longer give agents tools';
    expect(await elsewhere.answerAppCall(CALLER, read('n-5'))).toBeNull();
  });

  it('refuses a data file over 1 MB on the session\'s machine whole, naming the file — never cut (owner 10-17)', async () => {
    mkdirSync(join(folder.root, 'spexcode'), { recursive: true });
    writeFileSync(join(folder.root, 'spexcode', 'grown.json'), 'x'.repeat(MB + 1));
    expect(await refusal(elsewhere.answerAppCall(CALLER, data('readData', { path: 'grown.json' }, 'g-1')))).toEqual({
      code: 'too-large',
      message: 'grown.json is 1025 KB on the session\'s machine; a page reads and writes a data file on another machine up to 1 MB (8 MB on its own machine)',
    });
  });
});

describe('the asking machine', () => {
  const MANIFEST = { name: 'SpexCode', version: '0.7.0', contributes: { tabs: [], mcpServers: [{ tools: 'tools.js' }] } } as never;
  const app = { extensionId: 'spexcode', manifest: MANIFEST };
  const there = () => sessionsElsewhere.mockResolvedValue({
    rows: [{ deviceId: 'dev-b', deviceLabel: 'server', session: { conversationId: 's-there', projectId: 'p-2', agent: null } }],
    unreached: [],
  });

  it('finds a session on another machine once, and tells a session of this computer from one nowhere', async () => {
    sessionsElsewhere.mockResolvedValue({
      rows: [{ deviceId: 'dev-b', deviceLabel: 'server', session: { conversationId: 's-there', projectId: 'p-2', agent: { userId: '0a000000-0000-4000-8000-0000000000b2' } } }],
      unreached: [],
    });
    expect(await elsewhere.sessionMachine('s-here')).toBeNull();
    expect(await elsewhere.sessionMachine('s-there')).toEqual({ deviceId: 'dev-b', deviceLabel: 'server', projectId: 'p-2', agentId: 'user:0a000000-0000-4000-8000-0000000000b2' });
    expect(await elsewhere.sessionMachine('s-there')).toMatchObject({ deviceId: 'dev-b' });
    expect(sessionsElsewhere).toHaveBeenCalledTimes(1);
    expect(await refusal(elsewhere.sessionMachine('s-nowhere'))).toMatchObject({ code: 'not-found' });
  });

  it('does a call for a session of this computer here, and sends one for a session elsewhere as the verb and its args', async () => {
    there();
    expect(await elsewhere.callOnSessionMachine(app, 's-here', 'readData', { path: 'a.json' }, false)).toEqual({ there: false });
    appCall.mockResolvedValueOnce(OK);
    expect(await elsewhere.callOnSessionMachine(app, 's-there', 'callProgram', { name: 'graph', arguments: { a: 1 } }, false)).toEqual({ there: true, value: OK });
    const [sent, deviceId, sentAction] = appCall.mock.calls[0]!;
    expect([sent, deviceId]).toEqual([{ extensionId: 'spexcode', extensionName: 'SpexCode' }, 'dev-b']);
    expect(sentAction).toMatchObject({ action: 'app_call', session_id: 's-there', version: '0.7.0', method: 'callProgram', args: { name: 'graph', arguments: { a: 1 } } });
    expect(typeof sentAction.call_id).toBe('string');
  });

  it('reads an offline or too old machine as unavailable, keeps that machine\'s own refusals, and calls no program there for an agent\'s page', async () => {
    there();
    for (const code of ['SESSION_DEVICE_OFFLINE', 'SESSION_DEVICE_OUTDATED', 'SESSION_DEVICE_NO_ANSWER']) {
      appCall.mockRejectedValueOnce(Object.assign(new Error(`"server" (device:dev-b): ${code}`), { code }));
      expect(await refusal(elsewhere.callOnSessionMachine(app, 's-there', 'callProgram', { name: 'graph' }, false))).toEqual({ code: 'unavailable', message: `"server" (device:dev-b): ${code}` });
    }
    appCall.mockRejectedValueOnce(Object.assign(new Error('on "server": SpexCode is not installed on this machine'), { code: 'not-installed' }));
    expect(await refusal(elsewhere.callOnSessionMachine(app, 's-there', 'callProgram', { name: 'graph' }, false))).toMatchObject({ code: 'not-installed' });
    appCall.mockClear();
    expect(await refusal(elsewhere.callOnSessionMachine(app, 's-there', 'callProgram', { name: 'graph' }, true))).toMatchObject({ code: 'invalid' });
    // An agent's page still reads and writes the data folder there: only its program is its own, on this computer.
    appCall.mockResolvedValueOnce(null);
    expect(await elsewhere.callOnSessionMachine(app, 's-there', 'readData', { path: 'a.json' }, true)).toEqual({ there: true, value: null });
    expect(appCall).toHaveBeenCalledTimes(1);
  });

  it('does not send a call over 1 MB — a data file says it is the file, and that 1 MB is the limit across machines', async () => {
    there();
    expect(await refusal(elsewhere.callOnSessionMachine(app, 's-there', 'writeData', { path: 'big.json', content: 'x'.repeat(MB) }, false))).toMatchObject({
      code: 'too-large',
      message: expect.stringMatching(/^big\.json is 1025 KB; a page reads and writes a data file on another machine up to 1 MB/),
    });
    expect(await refusal(elsewhere.callOnSessionMachine(app, 's-there', 'callProgram', { name: 'graph', arguments: { blob: 'x'.repeat(MB) } }, false))).toMatchObject({ code: 'too-large' });
    expect(appCall).not.toHaveBeenCalled();
  });

  it('wired to the other machine\'s real answer, writes and reads back a data file of almost 1 MB whole, its text intact', async () => {
    there();
    appCall.mockImplementation((sent: { extensionId: string; extensionName: string }, _deviceId: string, sentAction: Parameters<typeof elsewhere.answerAppCall>[1]) =>
      elsewhere.answerAppCall({ kind: 'app', deviceId: 'dev-a', deviceLabel: 'laptop', ...sent }, { ...sentAction, session_id: 's-here' }));
    const big = '规'.repeat(300_000); // 900 KB of UTF-8
    expect(await elsewhere.callOnSessionMachine(app, 's-there', 'writeData', { path: 'big.json', content: big }, false)).toEqual({ there: true, value: undefined });
    expect(readFileSync(join(folder.root, 'spexcode', 'big.json'), 'utf8')).toBe(big);
    expect(await elsewhere.callOnSessionMachine(app, 's-there', 'readData', { path: 'big.json' }, false)).toEqual({ there: true, value: big });
    expect(appCall).toHaveBeenCalledTimes(2);
  });
});
