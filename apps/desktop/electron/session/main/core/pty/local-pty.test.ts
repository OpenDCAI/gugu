import type { PosixPtyTerminator } from '@gugu/session-core/pty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as nodePty from 'node-pty';
import { LocalPtyOwner, LocalPtySession, spawnLocalPty } from './local-pty';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

describe('LocalPtySession', () => {
  type MockPtyProcess = ConstructorParameters<typeof LocalPtySession>[1];

  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  let mockProc: MockPtyProcess;
  let posixTerminator: Pick<PosixPtyTerminator, 'kill' | 'markExited'>;
  let pty: LocalPtySession;

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
      ...originalPlatform,
      value: platform,
    });
  }

  function createPty(pid = 1234): void {
    mockProc = {
      pid,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    } as unknown as MockPtyProcess;
    posixTerminator = {
      kill: vi.fn(),
      markExited: vi.fn(),
    };
    pty = new LocalPtySession('test-id', mockProc, posixTerminator);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    createPty();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('kill() delegates POSIX process-tree termination', () => {
    setPlatform('linux');

    pty.kill();

    expect(posixTerminator.kill).toHaveBeenCalledTimes(1);
    const [pid, killPty] = vi.mocked(posixTerminator.kill).mock.calls[0]!;
    expect(pid).toBe(1234);
    expect(mockProc.kill).not.toHaveBeenCalled();

    killPty();
    expect(mockProc.kill).toHaveBeenCalledTimes(1);
  });

  it('kill() does not use POSIX termination on Windows', () => {
    setPlatform('win32');

    pty.kill();

    expect(posixTerminator.kill).not.toHaveBeenCalled();
    expect(mockProc.kill).toHaveBeenCalledTimes(1);
  });

  it('kill() falls back to node-pty when pid is unavailable', () => {
    setPlatform('linux');
    createPty(0);

    pty.kill();

    expect(posixTerminator.kill).not.toHaveBeenCalled();
    expect(mockProc.kill).toHaveBeenCalledTimes(1);
  });

  it('owner kills sessions that have not reported a native exit', () => {
    const owner = new LocalPtyOwner();
    const sessions = [1, 2].map(() => {
      let exitHandler: (() => void) | undefined;
      return {
        kill: vi.fn(),
        onExit: vi.fn((handler: () => void) => {
          exitHandler = handler;
        }),
        exit: () => exitHandler?.(),
      };
    });
    sessions.forEach((session) => owner.own(session));
    sessions[0]!.exit();

    owner.dispose();

    expect(sessions.map((session) => session.kill.mock.calls.length)).toEqual([0, 1]);
    expect(() => owner.assertAccepting()).toThrow('Local PTY owner is disposing');
  });

  // Windows 自带的 ConPTY 吃掉 TUI 问背景色的 OSC 10/11,两端配色因此不一致
  // (根因与实测见 @gugu/session-core 的 pty/node/conpty.ts)。钉住这个选项确实传到了 node-pty。
  it('spawns through the bundled ConPTY so terminal queries reach the host', () => {
    const spawnSpy = vi.mocked(nodePty.spawn);
    spawnSpy.mockReturnValue({
      pid: 4321,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    } as unknown as ReturnType<typeof nodePty.spawn>);

    spawnLocalPty({
      id: 'conpty-test',
      command: 'agent',
      args: ['--login'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
      cols: 80,
      rows: 24,
    });

    expect(spawnSpy).toHaveBeenCalledWith(
      'agent',
      ['--login'],
      expect.objectContaining({ useConptyDll: true })
    );
  });
});
