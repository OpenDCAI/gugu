// D-31 (owner 10-06「怎么符合用户思维和操作路径怎么来」; L11 复核 67): an agent's App install is asked as an approval on its
// session's timeline — wherever the person follows it, a chat-UI session or a terminal one — and in this window too, raised in
// front of them only when they are at this computer (125 10-06: the in-use branch is checked here and with the main-process
// hook, never by raising a window on mac1). Only an install answered on a sheet that showed it is taken.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ powerMonitor: { getSystemIdleTime: () => 999 } }));
vi.mock('./extension-bridge-relay', () => ({ requestExtensionInstallConsent: vi.fn(), closeExtensionInstallConsent: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { askInstallInSession, IN_USE_IDLE_SECONDS } = await import('./consent-in-session');
const { INSTALL_CONSENT_HUMAN_WINDOW_MS } = await import('@shared/extensions/host-actions');

const request = {
  sourceDir: '/tmp/reader',
  manifest: { id: 'reader', name: 'Reader' },
  manifestDigest: 'digest-r',
  revokedPermissions: [],
  places: [{ id: 'here:all', kind: 'here', enabled: true }],
} as never;
const requester = { name: 'Claude 1', agentUserId: 'agent-1' };

type Asked = {
  sessionId: string;
  request: { itemId: string; title: string; options: { optionId: string }[]; origin: { source: string; payload: { request: Record<string, unknown> } } };
  options: { signal: AbortSignal; refuse?: (answer: { optionId: string; digest?: string }) => string | null };
};
type Answer = { optionId: string; by: string; digest?: string; enableIn?: string[] } | 'withdrawn' | 'unavailable';

/** The session timeline as ask / respond see it: `answer` settles the ask as a surface's respond would. */
function world(options: { idle?: number; window?: (request: unknown) => Promise<{ outcome: string; enableIn?: string[] }> } = {}) {
  const asked: Asked[] = [];
  let answer: (result: Answer) => void = () => undefined;
  const responses: Record<string, unknown>[] = [];
  const timeline = {
    ask: (sessionId: string, ask: Asked['request'], opts: Asked['options']) => {
      asked.push({ sessionId, request: ask, options: opts });
      return new Promise<Answer>((resolve) => {
        answer = resolve;
        opts.signal.addEventListener('abort', () => resolve('withdrawn'));
      });
    },
    respond: async (input: Record<string, unknown>) => {
      responses.push(input);
      const refusal = asked[0]?.options.refuse?.(input as never);
      if (refusal) return { ok: false, error: { code: 'host_ask_refused', message: refusal } };
      answer({ optionId: input.optionId as string, by: input.by as string, ...(input.digest ? { digest: input.digest as string } : {}), ...(input.enableIn ? { enableIn: input.enableIn as string[] } : {}) });
      return { ok: true, value: { accepted: true } };
    },
  };
  const windows: { request: Record<string, unknown>; raise: boolean }[] = [];
  const closed: string[] = [];
  const dependencies = {
    timeline: async () => timeline as never,
    idleSeconds: () => options.idle ?? 999,
    window: (sheet: unknown, { raise }: { raise: boolean }) => {
      windows.push({ request: sheet as Record<string, unknown>, raise });
      return options.window ? options.window(sheet) : new Promise<never>(() => undefined);
    },
    closeWindow: async (requestId: string) => void closed.push(requestId),
  };
  return { asked, windows, closed, responses, dependencies, answer: (result: Answer) => answer(result) };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.useRealTimers());

describe('an agent’s App install, asked as an approval in its session (D-31)', () => {
  it("asks on the agent's session: who asks, for what, the two answers — the window draws the same ask", async () => {
    const w = world();
    const result = askInstallInSession('conv-1', request, requester, w.dependencies as never);
    await flush();
    expect(w.asked).toHaveLength(1);
    const { request: ask, sessionId } = w.asked[0]!;
    expect(sessionId).toBe('conv-1');
    expect(ask.options.map((option) => option.optionId)).toEqual(['install', 'decline']);
    expect(ask.origin.source).toBe('app-install');
    expect(ask.origin.payload.request).toMatchObject({ manifestDigest: 'digest-r', requestId: ask.itemId, requester });
    expect(w.windows[0]?.request).toMatchObject({ requestId: ask.itemId, requester });
    // Answered on another surface, with what it showed and where the person ticked: the sheet here goes.
    w.answer({ optionId: 'install', by: 'phone', digest: 'digest-r', enableIn: ['g1'] });
    await expect(result).resolves.toEqual({ outcome: 'confirmed', enableIn: ['g1'] });
    expect(w.closed).toEqual([ask.itemId]);
  });

  it('an install answered without the fingerprint of what it may do is refused — the ask stays (an older screen)', async () => {
    const w = world();
    void askInstallInSession('conv-1', request, requester, w.dependencies as never);
    await flush();
    const refuse = w.asked[0]!.options.refuse!;
    expect(refuse({ optionId: 'install' })).toMatch(/shows what it may do/);
    expect(refuse({ optionId: 'install', digest: 'digest-other' })).toMatch(/shows what it may do/);
    expect(refuse({ optionId: 'install', digest: 'digest-r' })).toBeNull();
    // No is no, from any screen.
    expect(refuse({ optionId: 'decline' })).toBeNull();
  });

  it('comes in front of the person only when they are at this computer', async () => {
    const away = world({ idle: IN_USE_IDLE_SECONDS });
    void askInstallInSession('conv-1', request, requester, away.dependencies as never);
    const here = world({ idle: IN_USE_IDLE_SECONDS - 1 });
    void askInstallInSession('conv-1', request, requester, here.dependencies as never);
    await flush();
    expect(away.windows.map((window) => window.raise)).toEqual([false]);
    expect(here.windows.map((window) => window.raise)).toEqual([true]);
  });

  it("this window's answer goes through the session's respond, with the fingerprint of the sheet it showed", async () => {
    const w = world({ window: async () => ({ outcome: 'confirmed', enableIn: ['here:all'] }) });
    const result = askInstallInSession('conv-1', request, requester, w.dependencies as never);
    await expect(result).resolves.toEqual({ outcome: 'confirmed', enableIn: ['here:all'] });
    expect(w.responses).toEqual([
      { conversationId: 'conv-1', itemId: w.asked[0]!.request.itemId, kind: 'permission', optionId: 'install', digest: 'digest-r', enableIn: ['here:all'], by: 'desktop' },
    ]);
  });

  it('a no here is a no in the session', async () => {
    const w = world({ window: async () => ({ outcome: 'declined' }) });
    await expect(askInstallInSession('conv-1', request, requester, w.dependencies as never)).resolves.toEqual({ outcome: 'declined' });
    expect(w.responses[0]).toMatchObject({ optionId: 'decline' });
    expect(w.responses[0]).not.toHaveProperty('digest');
  });

  it('nobody answers within the person’s window: the ask is withdrawn and the agent is told it timed out', async () => {
    vi.useFakeTimers();
    const w = world();
    const result = askInstallInSession('conv-1', request, requester, w.dependencies as never);
    await vi.advanceTimersByTimeAsync(INSTALL_CONSENT_HUMAN_WINDOW_MS - 1);
    expect(w.asked[0]?.options.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ outcome: 'timeout' });
  });

  it("the agent's call goes away (its turn stopped): the ask is withdrawn, not left for nobody", async () => {
    const w = world();
    const call = new AbortController();
    const result = askInstallInSession('conv-1', request, requester, w.dependencies as never, call.signal);
    await flush();
    call.abort();
    await expect(result).resolves.toEqual({ outcome: 'dismissed' });
    expect(w.asked[0]?.options.signal.aborted).toBe(true);
  });

  it('no such session here: this window alone asks, nothing sent to a session', async () => {
    const w = world({ window: async () => ({ outcome: 'confirmed', enableIn: ['here:all'] }) });
    w.dependencies.timeline = async () => ({ ask: async () => 'unavailable' as const, respond: vi.fn() }) as never;
    await expect(askInstallInSession('conv-1', request, requester, w.dependencies as never)).resolves.toEqual({ outcome: 'confirmed', enableIn: ['here:all'] });
    expect(w.responses).toEqual([]);
  });

  it('a Gugu server has no window: the session’s approval is the only ask', async () => {
    const w = world();
    const result = askInstallInSession('conv-1', request, requester, { ...w.dependencies, window: null } as never);
    await flush();
    w.answer({ optionId: 'decline', by: 'phone' });
    await expect(result).resolves.toEqual({ outcome: 'declined' });
    expect(w.windows).toEqual([]);
  });
});
