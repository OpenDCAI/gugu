import { describe, expect, it, vi } from 'vitest';
import { AppModalSessions } from './app-modal';

const options = (id = 'one') => ({ id, entry: 'dialogs/new.html', title: 'New card', data: { column: 'todo' } });

describe('App modal lifetime', () => {
  it('accepts only a page of the installed bundle, with no permission word', () => {
    const modals = new AppModalSessions(vi.fn());
    for (const entry of ['../other.html', '/other.html', 'https://outside/a.html', 'a%2f..%2fb.html', 'a.html?b']) {
      expect(() => modals.open(1, {}, { ...options(), entry })).toThrow();
    }
    expect(modals.open(1, { chat: 'a' }, options()).options.data).toEqual({ column: 'todo' });
  });

  it('binds a distinct child and returns a submitted result once', async () => {
    const finished = vi.fn();
    const modals = new AppModalSessions(finished);
    const session = modals.open(1, { chat: 'a' }, options());
    expect(() => modals.bind('one', 1)).toThrow();
    modals.bind('one', 2);
    expect(() => modals.bind('one', 3)).toThrow();
    expect(() => modals.forPage(1)).toThrow();
    await modals.close(modals.forPage(2).id, { card: 'created' });
    await expect(modals.result(session)).resolves.toEqual({ card: 'created' });
    await modals.close('one', 'again');
    expect(finished).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ opener: 1, child: 2 }), { card: 'created' }, undefined);
  });

  it('cancels descendant dialogs when the opener goes away', async () => {
    const finished = vi.fn();
    const modals = new AppModalSessions(finished);
    modals.open(1, {}, options());
    modals.bind('one', 2);
    modals.open(2, {}, options('two'));
    modals.bind('two', 3);
    await modals.pageGone(1);
    const failed = modals.open(4, {}, options('failed'));
    await modals.close('failed', null, 'The page did not load');
    await expect(modals.result(failed)).rejects.toThrow('The page did not load');
    expect(finished.mock.calls.slice(0, 2).map(([session, result]) => [session.id, result])).toEqual([['two', null], ['one', null]]);
    expect(() => modals.get('one')).toThrow();
    expect(() => modals.get('two')).toThrow();
  });

  it('rejects a repeated request without replacing its opener', () => {
    const modals = new AppModalSessions(vi.fn());
    modals.open(1, {}, options());
    expect(() => modals.open(2, {}, options())).toThrow();
    expect(modals.get('one').opener).toBe(1);
  });
});
