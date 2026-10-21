import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnOwnedChild } from './owned-child';
import { planDirectSpawn } from './windows-launcher';

// Windows 那一半在任何平台上都用假件跑:spawn 与 execFile 由这里接管,其余照旧。
const fake = vi.hoisted(() => ({
  spawn: null as null | ((...args: unknown[]) => unknown),
  execFile: null as null | ((...args: unknown[]) => unknown),
}));
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: (...args: unknown[]) => (fake.spawn ?? (real.spawn as (...a: unknown[]) => unknown))(...args),
    execFile: (...args: unknown[]) => (fake.execFile ?? (real.execFile as (...a: unknown[]) => unknown))(...args),
  };
});

afterEach(() => {
  fake.spawn = null;
  fake.execFile = null;
});

const SHIM = 'C:\\Users\\u\\AppData\\Roaming\\npm\\opencode.cmd';
const EXE = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe';

describe('planDirectSpawn: the shell exists only when the shim cannot be replaced', () => {
  it('a single-program npm shim spawns its exe directly, no cmd.exe', () => {
    const plan = planDirectSpawn(SHIM, ['serve', '--port', '1'], {
      platform: 'win32',
      readShim: () => '@ECHO off\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n',
      exists: (candidate) => candidate === EXE,
    });
    expect(plan).toEqual({ command: EXE, args: ['serve', '--port', '1'], spawnOverrides: {}, wrapsShell: false });
  });

  it('a node-script shim cannot be replaced, so it is wrapped and says so', () => {
    const plan = planDirectSpawn(SHIM, ['serve'], {
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      readShim: () => '@ECHO off\r\nnode "%dp0%\\node_modules\\x\\cli.js" %*\r\n',
      exists: () => true,
    });
    expect(plan.command).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(plan.wrapsShell).toBe(true);
  });
});

/** A child that is as alive as `pid` says: our own pid probes alive, a free pid probes dead. */
function fakeChild(pid: number) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(),
    exit(code = 1) {
      child.exitCode = code;
      child.emit('exit', code, null);
    },
  });
  fake.spawn = () => child;
  return child;
}

const DEAD_PID = 2 ** 22 - 3;

/** Records every taskkill; `outcome` decides how each one ends. */
function taskkills(outcome: (pid: string) => Error | null) {
  const calls: string[][] = [];
  fake.execFile = (file: unknown, args: unknown, _options: unknown, callback: unknown) => {
    calls.push([String(file), ...(args as string[])]);
    const error = outcome((args as string[])[1]!);
    setImmediate(() => (callback as (e: Error | null, o: string, s: string) => void)(error, '', error ? 'Access is denied.' : ''));
    return new EventEmitter();
  };
  return calls;
}

describe('OwnedChild error outlet', () => {
  it("the child's own 'error' event lands in onError (a spawn failure never goes unheard)", () => {
    const child = fakeChild(process.pid);
    const errors: Error[] = [];
    spawnOwnedChild('C:\\x\\agent.exe', [], { platform: 'win32', onError: (e) => errors.push(e) });
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    child.emit('error', enoent);
    expect(errors).toEqual([enoent]);
  });
});

describe('OwnedChild on Windows', () => {
  it('kill() stops the whole tree with an async taskkill /T /F on the live root, never child.kill()', async () => {
    const child = fakeChild(process.pid);
    const calls = taskkills(() => null);
    const owned = spawnOwnedChild('C:\\x\\agent.exe', [], { platform: 'win32', onError: () => {} });
    owned.kill('SIGTERM');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.slice(1)).toEqual(['/PID', String(process.pid), '/T', '/F']);
    expect(calls[0]![0]).toMatch(/System32\\taskkill\.exe$/);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('an exited root is never signalled by pid (the pid may belong to someone else now)', async () => {
    const child = fakeChild(process.pid);
    const calls = taskkills(() => null);
    const owned = spawnOwnedChild('C:\\x\\agent.exe', [], { platform: 'win32', onError: () => {} });
    child.exit();
    owned.kill();
    await owned.stop();
    expect(calls).toEqual([]);
  });

  it('a failed taskkill on a live root is loud: onError for kill(), a rejection for stop()', async () => {
    fakeChild(process.pid);
    taskkills(() => new Error('Command failed'));
    const errors: Error[] = [];
    let reported!: () => void;
    const errorReported = new Promise<void>((resolve) => (reported = resolve));
    const owned = spawnOwnedChild('C:\\x\\agent.exe', [], {
      platform: 'win32',
      onError: (e) => {
        errors.push(e);
        reported();
      },
    });
    owned.kill();
    await errorReported;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/taskkill \/T \/F \d+ failed: Command failed Access is denied\./);
    await expect(owned.stop()).rejects.toThrow(/taskkill/);
  });

  it('a failed taskkill whose root is already gone is the normal race, not an error', async () => {
    fakeChild(DEAD_PID);
    const calls = taskkills(() => new Error('not found'));
    const errors: Error[] = [];
    const owned = spawnOwnedChild('C:\\x\\agent.exe', [], { platform: 'win32', onError: (e) => errors.push(e) });
    owned.kill();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors).toEqual([]);
  });

  it('stop() resolves only once the root has exited, and kill() then stop() share one taskkill', async () => {
    const child = fakeChild(process.pid);
    const calls = taskkills(() => null);
    // 「根没退出就不算停下」:时钟走在假的上面,把 stop() 的轮询推过大半个默认期限(2s+2s),它仍不能 resolve;
    // 根一退出它就 resolve。❌ 真睡 150ms 再断言「还没发生」。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const owned = spawnOwnedChild('C:\\x\\agent.exe', [], { platform: 'win32', onError: () => {} });
      owned.kill();
      let stopped = false;
      const stopping = owned.stop().then(() => (stopped = true));
      // taskkill 替身在 setImmediate 里回调(先于这一个排上):它回来之后 stop() 才进入「等根退出」的轮询。
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(stopped).toBe(false);
      child.exit();
      await stopping;
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a root that never exits after taskkill rejects stop() instead of reporting it stopped', async () => {
    fakeChild(process.pid);
    taskkills(() => null);
    const owned = spawnOwnedChild('C:\\x\\agent.exe', [], { platform: 'win32', onError: () => {} });
    await expect(owned.stop({ graceMs: 50, killMs: 50 })).rejects.toThrow(/still running 100ms after taskkill/);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** sh 起一个后台 sleep(孙进程)并报出它的 pid。 */
async function shellWithGrandchild(detached: boolean) {
  const owned = spawnOwnedChild('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { detached, onError: () => {} });
  const grandchild = await new Promise<number>((resolve) => {
    owned.child.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
  });
  expect(alive(grandchild)).toBe(true);
  return { owned, grandchild };
}

describe.skipIf(process.platform === 'win32')('OwnedChild on POSIX (real processes)', () => {
  it('stop() on a detached child takes the whole group, grandchildren included', async () => {
    const { owned, grandchild } = await shellWithGrandchild(true);
    await owned.stop();
    expect(alive(grandchild)).toBe(false);
  });

  it('negative control: a child without its own group loses only itself — the grandchild survives', async () => {
    const { owned, grandchild } = await shellWithGrandchild(false);
    try {
      await owned.stop();
      expect(alive(grandchild)).toBe(true);
    } finally {
      process.kill(grandchild, 'SIGKILL');
    }
  });

  it('a TERM-ignoring child is escalated to SIGKILL after the grace period', async () => {
    const owned = spawnOwnedChild('/bin/sh', ['-c', 'trap "" TERM; echo ready; while :; do sleep 1; done'], {
      detached: true,
      onError: () => {},
    });
    await new Promise((resolve) => owned.child.stdout!.once('data', resolve));
    const started = Date.now();
    await owned.stop({ graceMs: 200, killMs: 2_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(owned.child.signalCode).toBe('SIGKILL');
  });
});
