import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { EXTENSION_GUIDE_PROGRAMS } from '../shared/extensions/authoring-guide';
import { mapProxy } from './json-proxy';
import { serveTools, toolsOf } from './tools-host';

/**
 * 摩擦单 F77 (S22: to let agents follow a card, an agent hand-wrote a 96-line stdio MCP server — 29 calls, three installs —
 * or kept a list in the data file). An App's tools module is served by gugu: every export one tool, MCP's Tool plus
 * `run(args, { agent })`, the caller only ever from `_meta['gugu/agent']`.
 */
const AGENT = 'user:0a000000-0000-4000-8000-000000000077';
function callerStamp(call: unknown) {
  const { signal, ...stamp } = call as Record<string, unknown>;
  expect(signal).toBeInstanceOf(AbortSignal);
  return stamp;
}
/** An open JSON file's data, as a program has it (`f.data`): what is assigned into it is copied in, as at run time. */
const openData = () => mapProxy(new Y.Doc().getMap('root'), () => true) as Record<string, Record<string, true>>;
const board = openData();
const module = {
  follow: {
    description: 'Be told when this card changes',
    inputSchema: { type: 'object', properties: { card: { type: 'string' } }, required: ['card'] },
    run({ card }: Record<string, unknown>, { agent }: { agent?: string }) {
      if (!agent) throw new Error('only an agent follows a card');
      if (!board[String(card)]) board[String(card)] = {};
      board[String(card)]![agent] = true;
      return `following card ${String(card)}`;
    },
  },
  followers: {
    description: 'Who follows a card',
    inputSchema: { type: 'object', properties: { card: { type: 'string' } } },
    _meta: { ui: { visibility: ['model', 'app'] } },
    run: ({ card }: Record<string, unknown>) => Object.keys(board[String(card)] ?? {}),
  },
};

async function served(exports: Record<string, unknown>) {
  const [client, server] = InMemoryTransport.createLinkedPair();
  await serveTools(toolsOf(exports, 'tools.js'), server, { name: 'board', version: '1' });
  const agent = new Client({ name: 'gateway', version: '1' });
  await agent.connect(client);
  return agent;
}

describe('an App\'s tools module, served as MCP by gugu (F77)', () => {
  it('passes real MCP cancellation to the program’s driver signal', async () => {
    let driverSignal: AbortSignal | undefined;
    let aborted = false;
    const client = await served({ wait: {
      description: 'Wait for cancellation', inputSchema: { type: 'object', properties: {} },
      run: (_args: unknown, call: { signal: AbortSignal }) => new Promise(resolve => {
        driverSignal = call.signal;
        call.signal.addEventListener('abort', () => { aborted = true; resolve('cancelled'); }, { once: true });
      }),
    } });
    const controller = new AbortController();
    const pending = client.callTool({ name: 'wait', arguments: { signal: 'forged' } }, undefined, { signal: controller.signal });
    const rejected = expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(driverSignal).toBeInstanceOf(AbortSignal));
    expect(driverSignal!.aborted).toBe(false);
    controller.abort(); await rejected;
    await vi.waitFor(() => expect(aborted).toBe(true));
    await client.close();
  });

  it('lists every export as a tool, its own fields as they are — run stays in the program', async () => {
    const client = await served(module);
    const { tools } = await client.listTools();
    expect(tools).toEqual([
      { name: 'follow', description: 'Be told when this card changes', inputSchema: module.follow.inputSchema },
      { name: 'followers', description: 'Who follows a card', inputSchema: module.followers.inputSchema, _meta: { ui: { visibility: ['model', 'app'] } } },
    ]);
  });

  it('a call: the caller is _meta["gugu/agent"] alone; a string answers as text, anything else as its JSON', async () => {
    const client = await served(module);
    const followed = await client.callTool({ name: 'follow', arguments: { card: '17', agent: 'user:fake' }, _meta: { 'gugu/agent': AGENT } });
    expect(followed).toEqual({ content: [{ type: 'text', text: 'following card 17' }] });
    expect(await client.callTool({ name: 'followers', arguments: { card: '17' } })).toEqual({ content: [{ type: 'text', text: JSON.stringify([AGENT]) }] });
  });

  /**
   * The guide's own example, run on an open file's data (海龟汤车道 10-19, mac1): `(f.data.followers[card] ??= {})[agent]`
   * lost the follow — the `{}` assigned is copied into the file, and `??=` answers that object, not the file's copy. No
   * proxy can mend it: an assignment answers what was assigned.
   */
  it("the guide's follow example keeps the follow in the file; the ??= spelling it had loses it", async () => {
    const example = /```js\n(export const follow = [\s\S]*?)\n```/.exec(EXTENSION_GUIDE_PROGRAMS)![1]!;
    const follow = async (code: string) => {
      const data = openData();
      data.followers = {};
      const gugu = { files: { open: async () => ({ data }) } };
      const tool = new Function('gugu', code.replace('export const follow =', 'return')) as (g: typeof gugu) => { run: (args: unknown, call: unknown) => Promise<string> };
      expect(await tool(gugu).run({ board: 'b', card: '17' }, { agent: AGENT })).toBe('following 17');
      return JSON.parse(JSON.stringify(data));
    };
    expect(await follow(example)).toEqual({ followers: { 17: { [AGENT]: true } } });
    const written = 'if (!f.data.followers[card]) f.data.followers[card] = {}\n    f.data.followers[card][agent] = true';
    expect(example).toContain(written);
    expect(await follow(example.replace(written, ';(f.data.followers[card] ??= {})[agent] = true'))).toEqual({ followers: { 17: {} } });
  });

  it('the caller\'s session and working copy come from the same stamp; what was not stamped is absent, never empty', async () => {
    const seen: unknown[] = [];
    const client = await served({
      where: { description: 'Where the caller is', inputSchema: { type: 'object', properties: {} }, run: (_args: unknown, call: unknown) => (seen.push(call), 'ok') },
    });
    await client.callTool({ name: 'where', arguments: { session: 'forged' }, _meta: { 'gugu/agent': AGENT, 'gugu/sessionId': 's-77', 'gugu/workspaceRoot': '/work/s-77' } });
    await client.callTool({ name: 'where', arguments: {}, _meta: { 'gugu/agent': AGENT, 'gugu/sessionId': 's-77' } });
    await client.callTool({ name: 'where', arguments: {}, _meta: { 'gugu/agent': AGENT, 'gugu/sessionId': '', 'gugu/workspaceRoot': 7 } });
    await client.callTool({ name: 'where', arguments: {} });
    expect(seen.map(callerStamp)).toStrictEqual([
      { agent: AGENT, session: 's-77', workspaceRoot: '/work/s-77' },
      { agent: AGENT, session: 's-77' },
      { agent: AGENT },
      {},
    ]);
  });

  it('the model gugu runs the caller on comes from the same stamp (gugu/model), never an argument; none stamped, none passed', async () => {
    const seen: unknown[] = [];
    const client = await served({
      who: { description: 'Which model called', inputSchema: { type: 'object', properties: {} }, run: (_args: unknown, call: unknown) => (seen.push(call), 'ok') },
    });
    await client.callTool({ name: 'who', arguments: { model: 'forged' }, _meta: { 'gugu/agent': AGENT, 'gugu/model': 'platform:glm-5.3-flash' } });
    await client.callTool({ name: 'who', arguments: {}, _meta: { 'gugu/agent': AGENT, 'gugu/model': '' } });
    await client.callTool({ name: 'who', arguments: {}, _meta: { 'gugu/agent': AGENT } });
    expect(seen.map(callerStamp)).toStrictEqual([
      { agent: AGENT, model: 'platform:glm-5.3-flash' },
      { agent: AGENT },
      { agent: AGENT },
    ]);
  });

  it('a throw is an error answer with its message; no agent, no identity; an unknown tool is said', async () => {
    const client = await served(module);
    expect(await client.callTool({ name: 'follow', arguments: { card: '3' } })).toEqual({
      content: [{ type: 'text', text: 'only an agent follows a card\nBefore replying to this App error, read guide_read apps-fork. For a missing feature or App bug, ask "Shall I fork a version?" before making changes or building a workaround. Environment problems need their own fix.' }],
      isError: true,
    });
    expect(await client.callTool({ name: 'unfollow', arguments: {} })).toMatchObject({ isError: true, content: [{ text: 'no tool "unfollow" here; there are: follow, followers' }] });
  });

  it('an App error with a code still points to the guide', async () => {
    const error = Object.assign(new Error('the requested view is unavailable'), { code: 'APP_VIEW' });
    const client = await served({
      probe: { description: 'An App failure', inputSchema: { type: 'object', properties: {} }, run() { throw error; } },
    });
    expect(await client.callTool({ name: 'probe', arguments: {} })).toEqual({
      content: [{ type: 'text', text: `${error.message}\nBefore replying to this App error, read guide_read apps-fork. For a missing feature or App bug, ask "Shall I fork a version?" before making changes or building a workaround. Environment problems need their own fix.` }], isError: true,
    });
  });

  /** 看板 N1 (170 10-19): an agent's tool call changed what the App's pages show, and nothing told them. */
  it('a call that answered tells the pages which tool ran (tools/called); a throw or an unknown tool tells nothing', async () => {
    const client = await served(module);
    const heard: unknown[] = [];
    client.fallbackNotificationHandler = async ({ method, params }) => void heard.push({ method, params });
    await client.callTool({ name: 'follow', arguments: { card: '5' }, _meta: { 'gugu/agent': AGENT } });
    await client.callTool({ name: 'follow', arguments: { card: '5' } });
    await client.callTool({ name: 'unfollow', arguments: {} });
    await client.callTool({ name: 'followers', arguments: { card: '5' } });
    // The last call answered too: once its word is heard, every word before it has been.
    await expect.poll(() => heard.length).toBe(2);
    expect(heard).toStrictEqual([
      { method: 'tools/called', params: { tool: 'follow' } },
      { method: 'tools/called', params: { tool: 'followers' } },
    ]);
  });

  it('a module that is not all tools does not start — naming the export, and what to do instead', () => {
    const tool = module.follow;
    expect(() => toolsOf({ follow: tool, cardsOf: () => [] }, 'tools.js')).toThrow(
      'tools.js: "cardsOf" is a function, not a tool { description, inputSchema: { type: "object", properties }, run(args, { agent }) }. Every export of tools.js is a tool; a helper goes in another module that tools.js imports.',
    );
    expect(() => toolsOf({ default: tool }, 'tools.js')).toThrow(/a default export has no tool name/);
    expect(() => toolsOf({ follow: { ...tool, description: '' } }, 'tools.js')).toThrow('tools.js: "follow" has no description.');
    expect(() => toolsOf({ follow: { ...tool, inputSchema: { card: { type: 'string' } } } }, 'tools.js')).toThrow(/"follow" has no inputSchema of type "object"/);
    expect(() => toolsOf({}, 'tools.js')).toThrow(/^tools\.js exports no tools/);
  });

  it('a call runs inside its own call id (_meta["gugu/call"]): two at once each keep theirs, and its stamp; without one, none', async () => {
    const { programCall } = await import('./program-call');
    const seen: { callId: string | undefined; call: unknown }[] = [];
    const client = await served({
      probe: {
        description: 'Which call am I in',
        inputSchema: { type: 'object', properties: {} },
        async run(_args: unknown, call: unknown) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          seen.push({ callId: programCall.getStore(), call });
          return 'ok';
        },
      },
    });
    const stamp = (session: string) => ({ 'gugu/agent': AGENT, 'gugu/sessionId': session, 'gugu/workspaceRoot': `/work/${session}` });
    await Promise.all([
      client.callTool({ name: 'probe', arguments: {}, _meta: { ...stamp('s-a'), 'gugu/call': 'call-a' } }),
      client.callTool({ name: 'probe', arguments: {}, _meta: { ...stamp('s-b'), 'gugu/call': 'call-b' } }),
    ]);
    expect([...seen].sort((a, b) => String(a.callId).localeCompare(String(b.callId))).map(item => ({ ...item, call: callerStamp(item.call) }))).toStrictEqual([
      { callId: 'call-a', call: { agent: AGENT, session: 's-a', workspaceRoot: '/work/s-a' } },
      { callId: 'call-b', call: { agent: AGENT, session: 's-b', workspaceRoot: '/work/s-b' } },
    ]);
    await client.callTool({ name: 'probe', arguments: {}, _meta: stamp('s-c') });
    expect({ ...seen.at(-1), call: callerStamp(seen.at(-1)!.call) }).toStrictEqual({ callId: undefined, call: { agent: AGENT, session: 's-c', workspaceRoot: '/work/s-c' } });
  });
});
