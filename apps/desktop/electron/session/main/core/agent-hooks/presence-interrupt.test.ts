import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessPresenceFile } from '@gugu/session-core/agents/plugins';

const mocks = vi.hoisted(() => ({
  emitAgentEvent: vi.fn(),
  reportStatusSourceFault: vi.fn(),
  isWorkingOrWaiting: vi.fn(() => true),
  logError: vi.fn(),
}));
vi.mock('./agent-hook-service', () => ({ agentHookService: { emitAgentEvent: mocks.emitAgentEvent } }));
vi.mock('./app-focus', () => ({ isAppFocused: () => false }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({
  agentStatusWriter: { reportStatusSourceFault: mocks.reportStatusSourceFault, isWorkingOrWaiting: mocks.isWorkingOrWaiting },
}));
vi.mock('./harness-config-roots', () => ({ harnessConfigRootOf: () => undefined }));
vi.mock('@main/lib/logger', () => ({ log: { error: mocks.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const { watchPresenceInterrupt, startPresenceInterrupt, PRESENCE_POLL_MS, PRESENCE_APPEAR_WITHIN_MS } = await import('./presence-interrupt');
/** 与 claude 那份同形的读者(真解析器的判据在 session-plugins 的 claude/presence.test.ts)。 */
const claudePresenceFile: HarnessPresenceFile = {
  configDirEnvVar: 'CLAUDE_CONFIG_DIR',
  defaultConfigDirName: '.claude',
  directory: 'sessions',
  parse(text) {
    const r = JSON.parse(text) as { pid: number; sessionId: string; status: string };
    if (!['busy', 'idle', 'waiting', 'shell'].includes(r.status)) throw new Error(`status "${r.status}" is not one gugu knows`);
    return { pid: r.pid, sessionId: r.sessionId, status: r.status as 'busy' };
  },
};

/** 一份可改的「磁盘」:path → 内容;缺 = ENOENT。 */
function fakeFs(files: Map<string, string>) {
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    readFile: async (path: string) => {
      const text = files.get(path);
      if (text === undefined) throw enoent();
      return text;
    },
    readdir: async (dir: string) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
  };
}
const record = (pid: number, status: string, sessionId = 's-claude') => JSON.stringify({ pid, sessionId, status });
const PATH = '/home/u/.claude/sessions/42.json';

describe('watchPresenceInterrupt (spec hook-status-derivation「打断边:会话在场文件」)', () => {
  let files: Map<string, string>;
  let active: boolean;
  let interrupted: number;
  let faults: Array<string | null>;
  let stop: () => void;
  let harnessSessionId: string | undefined;
  let dead: Set<number>;
  let roots: string[];
  const start = () => {
    stop = watchPresenceInterrupt({
      presence: claudePresenceFile,
      configRoots: () => roots,
      harnessSessionId: () => harnessSessionId,
      isAlive: (pid) => !dead.has(pid),
      isActive: () => active,
      onInterrupted: () => {
        interrupted += 1;
      },
      onFault: (message) => faults.push(message),
      fs: fakeFs(files),
    });
  };
  const step = async (status?: string) => {
    if (status !== undefined) files.set(PATH, record(42, status));
    await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    files = new Map();
    active = true;
    interrupted = 0;
    faults = [];
    harnessSessionId = 's-claude';
    dead = new Set();
    roots = ['/home/u/.claude'];
  });
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
  });

  it('Esc on an approval: waiting → idle is one interrupt', async () => {
    start();
    await step('busy');
    await step('waiting');
    await step('idle');
    await step('idle');
    expect(interrupted).toBe(1);
    expect(faults).toEqual([]);
  });

  it('Esc mid-turn: busy → idle is one interrupt', async () => {
    start();
    await step('busy');
    await step('idle');
    expect(interrupted).toBe(1);
  });

  it('a background task finishing (shell → idle) is not an interrupt', async () => {
    start();
    await step('shell');
    await step('idle');
    expect(interrupted).toBe(0);
  });

  it('idle seen first (the turn has not begun yet) is not an interrupt', async () => {
    start();
    await step('idle');
    await step('busy');
    expect(interrupted).toBe(0);
  });

  it('reads nothing while the writer says it is neither working nor waiting', async () => {
    start();
    active = false;
    await step('busy');
    await step('idle');
    expect(interrupted).toBe(0);
    active = true;
    await step('idle');
    expect(interrupted).toBe(0);
  });

  it('a file that never appears while active is a fault after the grace, and clears once it reads', async () => {
    start();
    await vi.advanceTimersByTimeAsync(PRESENCE_APPEAR_WITHIN_MS + 2 * PRESENCE_POLL_MS);
    const missing = 'no sessions/<pid>.json for session s-claude under /home/u/.claude';
    expect(faults).toEqual([missing]);
    await step('busy');
    expect(faults).toEqual([missing, null]);
  });

  // 10-28 Linux 2:`claude` 是包装器(reclaude),配置目录由它在进程里设,在场文件在别处。harness 在 hook 里报了它的目录之后
  // 读者要在那里找到,❌ 只认 env / `~/.claude`;报之前不在宽限内判失效。
  it('a config root the harness reports later is searched too: found there, no fault within the grace', async () => {
    const wrapped = '/root/.rec/claude/accounts/1/config';
    start();
    await step();
    files.set(`${wrapped}/sessions/42.json`, record(42, 'busy'));
    await step();
    expect(faults).toEqual([]);
    roots = [wrapped, '/home/u/.claude'];
    await step();
    files.set(`${wrapped}/sessions/42.json`, record(42, 'idle'));
    await step();
    expect(interrupted).toBe(1);
    expect(faults).toEqual([]);
  });

  it('with the file only under the reported root and that root never reported, the fault names every root searched', async () => {
    roots = ['/home/u/.claude', '/home/u/other'];
    start();
    await vi.advanceTimersByTimeAsync(PRESENCE_APPEAR_WITHIN_MS + 2 * PRESENCE_POLL_MS);
    expect(faults).toEqual(['no sessions/<pid>.json for session s-claude under /home/u/.claude or /home/u/other']);
  });

  it('an unknown status or a file of another process is a fault, never an interrupt', async () => {
    start();
    await step('busy');
    await step('compacting');
    expect(faults.at(-1)).toMatch(/"compacting" is not one gugu knows/);
    files.set(PATH, record(7, 'idle'));
    await step();
    expect(faults.at(-1)).toMatch(/belongs to pid 7/);
    expect(interrupted).toBe(0);
  });

  it('a fault raised while working clears once the file reads again, even after the task went idle', async () => {
    start();
    await step('busy');
    await step('compacting');
    expect(faults.at(-1)).toMatch(/not one gugu knows/);
    active = false;
    await step('idle');
    expect(faults.at(-1)).toBeNull();
    expect(interrupted).toBe(0);
    files.set(PATH, record(42, 'busy'));
    await step();
    expect(faults.at(-1)).toBeNull();
  });

  it('the file is found by its harness session id, then followed by pid across /clear', async () => {
    files.set('/home/u/.claude/sessions/9.json', record(9, 'busy', 'someone-else'));
    files.set(PATH, record(42, 'busy', 'target'));
    harnessSessionId = 'target';
    start();
    await step();
    files.set(PATH, record(42, 'idle', 'renamed-by-clear'));
    await step();
    expect(interrupted).toBe(1);
    expect(faults).toEqual([]);
  });

  it('Windows relaunch: the pty child never writes; its `--resume` child does, under its own pid', async () => {
    start();
    await step();
    files.set('/home/u/.claude/sessions/7.json', record(7, 'busy'));
    await step();
    files.set('/home/u/.claude/sessions/7.json', record(7, 'idle'));
    await step();
    expect(interrupted).toBe(1);
    expect(faults).toEqual([]);
  });

  it('a locked file that goes away (the process was replaced) is looked up again with a fresh grace', async () => {
    start();
    await step('busy');
    await vi.advanceTimersByTimeAsync(PRESENCE_APPEAR_WITHIN_MS);
    files.delete(PATH);
    await step();
    await vi.advanceTimersByTimeAsync(PRESENCE_APPEAR_WITHIN_MS / 2);
    expect(faults).toEqual([]);
    files.set('/home/u/.claude/sessions/7.json', record(7, 'busy'));
    await step();
    files.set('/home/u/.claude/sessions/7.json', record(7, 'idle'));
    await step();
    expect(interrupted).toBe(1);
    expect(faults).toEqual([]);
  });

  it('a file left by a dead process with the same session id is not followed', async () => {
    files.set('/home/u/.claude/sessions/5.json', record(5, 'busy'));
    dead.add(5);
    start();
    await step();
    files.set('/home/u/.claude/sessions/5.json', record(5, 'idle'));
    files.set(PATH, record(42, 'busy'));
    await step();
    await step('idle');
    expect(interrupted).toBe(1);
  });

  it('a fork whose child id has not been reported yet reads nothing, and is a fault once overdue', async () => {
    harnessSessionId = undefined;
    files.set(PATH, record(42, 'busy', 'the-fork-source'));
    start();
    await vi.advanceTimersByTimeAsync(PRESENCE_APPEAR_WITHIN_MS + 2 * PRESENCE_POLL_MS);
    expect(faults).toEqual(['the harness has not reported its session id for this spawn']);
    harnessSessionId = 'fork-child';
    files.set('/home/u/.claude/sessions/8.json', record(8, 'busy', 'fork-child'));
    await step();
    expect(faults.at(-1)).toBeNull();
  });
});

describe('startPresenceInterrupt', () => {
  const plugin = {
    capabilities: { hooks: { kind: 'config' as const, scope: 'workspace' as const, supportedEvents: ['stop' as const], presence: { sinceVersion: '2.1.175' } } },
    behavior: { hooks: { presence: claudePresenceFile } },
  };
  const base = { spawnEnv: { HOME: '/home/u' }, harnessSessionId: () => 's-claude', sessionId: 's1', projectId: 'p1', providerId: 'claude' };
  beforeEach(() => {
    mocks.reportStatusSourceFault.mockClear();
    mocks.logError.mockClear();
  });

  it('an unknown harness version starts the task anyway: logged, marked, no reader, no throw', () => {
    expect(startPresenceInterrupt({ ...base, plugin, harnessVersion: null })).toBeUndefined();
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.reportStatusSourceFault).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', message: expect.stringMatching(/version of this spawn is unknown/) }));
  });

  it('an older harness has no reader and is marked like any presence that cannot be read', () => {
    expect(startPresenceInterrupt({ ...base, plugin, harnessVersion: '2.1.150' })).toBeUndefined();
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ harnessVersion: '2.1.150' }));
    expect(mocks.reportStatusSourceFault).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', message: expect.stringMatching(/since 2\.1\.175; this spawn is 2\.1\.150/) }));
  });

  it('declaring presence without registering a reader is a plugin bug: thrown at spawn', () => {
    expect(() => startPresenceInterrupt({ ...base, plugin: { ...plugin, behavior: {} }, harnessVersion: '2.1.301' })).toThrow(/registers no presence reader/);
  });

  it('a harness that does not declare it gets nothing', () => {
    expect(startPresenceInterrupt({ ...base, plugin: { capabilities: { hooks: { kind: 'none' as const } }, behavior: {} }, harnessVersion: null })).toBeUndefined();
    expect(mocks.reportStatusSourceFault).not.toHaveBeenCalled();
  });
});
