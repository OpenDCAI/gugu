import { describe, expect, it, vi } from 'vitest';
import { NodePtySpawner } from './node-pty-spawner';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node-pty', () => ({
  spawn: spawnMock,
}));

describe('NodePtySpawner', () => {
  it('lazy-loads node-pty and adapts the spawned process', async () => {
    const proc = {
      pid: 123,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
    spawnMock.mockReturnValue(proc);

    const spawned = await new NodePtySpawner().spawn({
      command: 'agent',
      args: ['--login'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
      cols: 80,
      rows: 24,
    });

    // useConptyDll:Windows 自带的 ConPTY 会吃掉 TUI 问背景色的 OSC 10/11,
    // 两端配色因此不一致(见 ./conpty.ts)。这里钉住「这个选项确实传到了 node-pty」。
    expect(spawnMock).toHaveBeenCalledWith('agent', ['--login'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
      useConptyDll: true,
    });
    spawned.write('input');
    spawned.resize(100, 30);
    expect(proc.write).toHaveBeenCalledWith('input');
    expect(proc.resize).toHaveBeenCalledWith(100, 30);
  });
});
