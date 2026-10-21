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
  const start = (location: Parameters<typeof watchPresenceInterrupt>[0]['location'] = { kind: 'pid', pid: 42 }) => {
    stop = watchPresenceInterrupt({
      presence: claudePresenceFile,
      configRoot: '/home/u/.claude',
      location,
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
    expect(faults).toEqual([`${PATH} did not appear`]);
    await step('busy');
    expect(faults).toEqual([`${PATH} did not appear`, null]);
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

  it('a tmux session is found once by its harness session id, then followed by pid', async () => {
    files.set('/home/u/.claude/sessions/9.json', record(9, 'busy', 'someone-else'));
    files.set(PATH, record(42, 'busy', 'target'));
    start({ kind: 'session', sessionId: 'target' });
    await step();
    files.set(PATH, record(42, 'idle', 'renamed-by-clear'));
    await step();
    expect(interrupted).toBe(1);
    expect(faults).toEqual([]);
  });
});

describe('startPresenceInterrupt', () => {
  const plugin = {
    capabilities: { hooks: { kind: 'config' as const, scope: 'workspace' as const, supportedEvents: ['stop' as const], presence: { sinceVersion: '2.1.175' } } },
    behavior: { hooks: { presence: claudePresenceFile } },
  };
  const base = { spawnEnv: { HOME: '/home/u' }, location: { kind: 'pid' as const, pid: 42 }, sessionId: 's1', projectId: 'p1', providerId: 'claude' };
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

  it('a pid-less pty is marked like a missing version', () => {
    expect(startPresenceInterrupt({ ...base, plugin, harnessVersion: '2.1.301', location: { kind: 'pid', pid: Number.NaN } })).toBeUndefined();
    expect(mocks.reportStatusSourceFault).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/no pid/) }));
  });

  it('declaring presence without registering a reader is a plugin bug: thrown at spawn', () => {
    expect(() => startPresenceInterrupt({ ...base, plugin: { ...plugin, behavior: {} }, harnessVersion: '2.1.301' })).toThrow(/registers no presence reader/);
  });

  it('a harness that does not declare it gets nothing', () => {
    expect(startPresenceInterrupt({ ...base, plugin: { capabilities: { hooks: { kind: 'none' as const } }, behavior: {} }, harnessVersion: null })).toBeUndefined();
    expect(mocks.reportStatusSourceFault).not.toHaveBeenCalled();
  });
});
