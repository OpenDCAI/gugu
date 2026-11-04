import { beforeEach, expect, it, vi } from 'vitest';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';

const state = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@main/core/execution-context/local-execution-context', () => ({ LocalExecutionContext: class {} }));
vi.mock('@main/core/pty/tmux-session-name', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listTmuxSessionNames: state.list,
}));

const { forgetSessionProcess, recordSessionProcess, sessionEngine } = await import('./session-process');
const { makeTmuxSessionName } = await import('@main/core/pty/tmux-session-name');

beforeEach(() => { state.list.mockReset().mockResolvedValue(new Set()); forgetSessionProcess('s'); });

it('reads an engine as owned, detached in tmux before reattach, or gone', async () => {
  recordSessionProcess('s', { home: 'tmux', start: 'reattach' });
  expect(await sessionEngine('s')).toBe('owned');
  expect(state.list).not.toHaveBeenCalled();
  forgetSessionProcess('s');
  // A terminal pane of the same task is not its engine.
  state.list.mockResolvedValue(new Set([makeTmuxSessionName(makePtySessionId('p', 's', 'terminal-1'))]));
  expect(await sessionEngine('s')).toBe('gone');
  state.list.mockResolvedValue(new Set([makeTmuxSessionName(makePtySessionId('p', 's', 's'))]));
  expect(await sessionEngine('s')).toBe('detached');
});

it('fails loudly when tmux cannot answer instead of reading the engine as gone', async () => {
  state.list.mockRejectedValue(new Error('cannot list tmux sessions'));
  await expect(sessionEngine('s')).rejects.toThrow('cannot list tmux sessions');
});
