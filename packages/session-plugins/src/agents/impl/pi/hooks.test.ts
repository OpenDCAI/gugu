import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CanonicalHookEvent } from '@gugu/session-core/agents/plugins';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { provider as pi } from '.';
import { parsePiHookEvent } from './hooks';
import { PI_EXTENSION_CONTENT } from './plugin-file';

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Extension = (api: { on(name: string, handler: Handler): void; events: { emit(): void } }) => void;

/**
 * 把真的事件模块(`PI_EXTENSION_CONTENT`,就是落到 `.pi/extensions/gugu-hook.ts` 的那份字节)编译加载,
 * 挂到一个假的 pi 上逐个触发事件,读它 POST 给宿主的东西,再过宿主的解析器 —— 模块与宿主两端一起测。
 */
let dir: string;
let extension: Extension;
const HOOK_ENV = { GUGU_HOOK_PORT: '1', GUGU_HOOK_TOKEN: 'token', GUGU_PTY_ID: 'pi-conv-c1' };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gugu-pi-ext-'));
  const file = join(dir, 'gugu-hook.ts');
  await writeFile(file, PI_EXTENSION_CONTENT);
  extension = ((await import(/* @vite-ignore */ pathToFileURL(file).href)) as { default: Extension }).default;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let fetchMock: ReturnType<typeof vi.fn>;
let processListeners: { uncaught: unknown[]; rejection: unknown[] };
beforeEach(() => {
  for (const [key, value] of Object.entries(HOOK_ENV)) vi.stubEnv(key, value);
  vi.stubEnv('GUGU_PI_AUTONOMY', undefined);
  vi.stubEnv('GUGU_PI_MCP_SERVERS', undefined);
  fetchMock = vi.fn(async () => new Response(null));
  vi.stubGlobal('fetch', fetchMock);
  processListeners = {
    uncaught: process.listeners('uncaughtException'),
    rejection: process.listeners('unhandledRejection'),
  };
});
afterEach(() => {
  // 模块在加载时挂了 process.once 的兜底上报;别让它留在测试进程里。
  for (const listener of process.listeners('uncaughtException')) {
    if (!processListeners.uncaught.includes(listener)) process.removeListener('uncaughtException', listener);
  }
  for (const listener of process.listeners('unhandledRejection')) {
    if (!processListeners.rejection.includes(listener)) process.removeListener('unhandledRejection', listener);
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function loadFakePi() {
  const handlers = new Map<string, Handler[]>();
  extension({
    on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    events: { emit: () => {} },
  });
  return {
    handles: (name: string) => handlers.has(name),
    async fire(name: string, event: unknown = {}) {
      for (const handler of handlers.get(name) ?? []) await handler(event, {});
    },
  };
}

/** 模块发给宿主的每一条,按宿主的解析器读回。 */
function posted(): CanonicalHookEvent[] {
  return fetchMock.mock.calls.map(([, init]) => {
    const request = init as { headers: Record<string, string>; body: string };
    return parsePiHookEvent(request.headers['X-Gugu-Event-Type']!, JSON.parse(request.body) as Record<string, unknown>);
  });
}

const assistant = (stopReason: string, errorMessage?: string) => ({ role: 'assistant', stopReason, ...(errorMessage ? { errorMessage } : {}) });
const user = { role: 'user', content: 'hi' };

// #6448:结算时按最后一次运行的结局报 —— 失败 = error,被 Esc 打断 = stop + cancelled,正常 = stop。
describe('pi event module: how a settled turn ended', () => {
  it('a run that ended in an error settles as error with its message, not as done', async () => {
    const piApi = loadFakePi();
    await piApi.fire('agent_start');
    await piApi.fire('agent_end', { messages: [user, assistant('error', '429 rate limited')] });
    await piApi.fire('agent_settled');
    expect(posted()).toEqual([
      expect.objectContaining({ type: 'start' }),
      expect.objectContaining({ kind: 'status', type: 'error', message: '429 rate limited' }),
    ]);
  });

  it('a failed run that auto-retried into a success settles as done', async () => {
    const piApi = loadFakePi();
    await piApi.fire('agent_start');
    await piApi.fire('agent_end', { messages: [user, assistant('error', 'overloaded')] });
    await piApi.fire('agent_start');
    await piApi.fire('agent_end', { messages: [assistant('stop')] });
    await piApi.fire('agent_settled');
    const last = posted().at(-1);
    expect(last).toMatchObject({ kind: 'status', type: 'stop' });
    expect(last).not.toHaveProperty('outcome');
  });

  it('an aborted run (Esc) settles as a cancelled stop', async () => {
    const piApi = loadFakePi();
    await piApi.fire('agent_start');
    await piApi.fire('agent_end', { messages: [user, assistant('aborted')] });
    await piApi.fire('agent_settled');
    expect(posted().at(-1)).toMatchObject({ kind: 'status', type: 'stop', outcome: 'cancelled' });
  });

  // mac1 B 臂实测:工具跑着时按 Esc,pi 记成 stopReason 'error' + 平台 AbortError 的固定消息。
  it('an Esc while a tool runs (error + the platform AbortError message) settles as a cancelled stop, not a failure', async () => {
    const piApi = loadFakePi();
    await piApi.fire('agent_start');
    await piApi.fire('agent_end', { messages: [user, assistant('error', 'This operation was aborted')] });
    await piApi.fire('agent_settled');
    expect(posted().at(-1)).toMatchObject({ kind: 'status', type: 'stop', outcome: 'cancelled' });
  });

  it('control: any other error message is still a failure', async () => {
    const piApi = loadFakePi();
    await piApi.fire('agent_start');
    await piApi.fire('agent_end', { messages: [user, assistant('error', 'The operation was aborted due to timeout')] });
    await piApi.fire('agent_settled');
    expect(posted().at(-1)).toMatchObject({ kind: 'status', type: 'error' });
  });

  it('a normal run settles as a plain stop, and the next turn starts clean', async () => {
    const piApi = loadFakePi();
    await piApi.fire('agent_start');
    await piApi.fire('agent_end', { messages: [user, assistant('toolUse'), assistant('stop')] });
    await piApi.fire('agent_settled');
    await piApi.fire('agent_settled');
    for (const event of posted().slice(1)) {
      expect(event).toMatchObject({ kind: 'status', type: 'stop' });
      expect(event).not.toHaveProperty('outcome');
    }
  });

  it('does not subscribe agent_before_settle (pi would build a boundary context on every settle for it)', () => {
    expect(loadFakePi().handles('agent_before_settle')).toBe(false);
  });
});

describe('pi event module: ctx.ui prompts are waits', () => {
  it.each([
    ['confirm', 'approval'],
    ['select', 'question'],
    ['input', 'question'],
    ['editor', 'question'],
    ['custom', 'dialog'],
  ])('ui_prompt %s → %s wait, resolved by its own end', async (kind, waitKind) => {
    const piApi = loadFakePi();
    await piApi.fire('ui_prompt_start', { type: 'ui_prompt_start', reason: 'ui_prompt', kind, title: 'Pick one' });
    await piApi.fire('ui_prompt_end', { type: 'ui_prompt_end', reason: 'ui_prompt', kind });
    expect(posted()).toEqual([
      { kind: 'status', type: 'wait', waitKind, waitId: 'ui-1', title: 'Pick one' },
      { kind: 'status', type: 'wait_resolved', waitId: 'ui-1' },
    ]);
  });

  it('nested prompts close last-opened first', async () => {
    const piApi = loadFakePi();
    await piApi.fire('ui_prompt_start', { kind: 'select' });
    await piApi.fire('ui_prompt_start', { kind: 'confirm' });
    await piApi.fire('ui_prompt_end', { kind: 'confirm' });
    await piApi.fire('ui_prompt_end', { kind: 'select' });
    expect(posted().map((event) => (event.kind === 'status' ? [event.type, event.waitId] : null))).toEqual([
      ['wait', 'ui-1'],
      ['wait', 'ui-2'],
      ['wait_resolved', 'ui-2'],
      ['wait_resolved', 'ui-1'],
    ]);
  });
});

describe('pi event module: quitting', () => {
  it('quit reports a cancelled stop (the host ignores it when no turn is open)', async () => {
    const piApi = loadFakePi();
    await piApi.fire('session_shutdown', { type: 'session_shutdown', reason: 'quit' });
    expect(posted()).toEqual([expect.objectContaining({ kind: 'status', type: 'stop', outcome: 'cancelled' })]);
  });

  it('a reload is not an exit and reports nothing', async () => {
    const piApi = loadFakePi();
    await piApi.fire('session_shutdown', { type: 'session_shutdown', reason: 'reload' });
    expect(posted()).toEqual([]);
  });
});

describe('pi host parser (the module’s own protocol)', () => {
  it('is the parser registered for pi', () => {
    expect(pi.behavior.hooks?.parseHookEvent).toBe(parsePiHookEvent);
  });

  it('declares the edges the module reports', () => {
    const hooks = pi.capabilities.hooks;
    expect(hooks.kind !== 'none' && [...hooks.supportedEvents].sort()).toEqual(
      ['error', 'session', 'start', 'stop', 'wait', 'wait_resolved'],
    );
  });

  it('reads a stop without outcome as a finished turn', () => {
    expect(parsePiHookEvent('stop', { message: 'Task completed' })).toEqual({
      kind: 'status',
      type: 'stop',
      message: 'Task completed',
      title: undefined,
      lastAssistantMessage: undefined,
    });
  });

  it('fails loud on a body the module never sends', () => {
    expect(() => parsePiHookEvent('stop', { outcome: 'done' })).toThrow(/unknown outcome/);
    expect(() => parsePiHookEvent('wait', { waitKind: 'question' })).toThrow(/no waitId/);
    expect(() => parsePiHookEvent('wait', { waitKind: 'confirm', waitId: 'ui-1' })).toThrow(/unknown waitKind/);
    expect(() => parsePiHookEvent('wait_resolved', {})).toThrow(/no waitId/);
  });
});
