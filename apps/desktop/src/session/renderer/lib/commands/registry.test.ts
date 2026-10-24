import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from './registry';

const surface = () => ({ closest: () => null }) as unknown as HTMLElement;

describe('live command dispatch', () => {
  it('find follows the focused surface and retains that target while a palette is open', () => {
    const registry = new CommandRegistry();
    const chat = surface();
    const terminal = surface();
    const findChat = vi.fn();
    const findTerminal = vi.fn();
    const disposeChat = registry.register({ scopeId: 'session-sub', isActive: (target) => target === chat,
      getCommands: () => [{ id: 'app.find', execute: findChat }] });
    registry.register({ scopeId: 'session-sub', isActive: (target) => target === terminal,
      getCommands: () => [{ id: 'app.find', execute: findTerminal }] });
    expect(registry.dispatch('app.find')).toBe(false);
    registry.setContext(chat);
    expect(registry.dispatch('app.find')).toBe(true);
    registry.setContext({ closest: () => ({}) } as unknown as HTMLElement);
    registry.dispatch('app.find');
    expect(findChat).toHaveBeenCalledTimes(2);
    expect(findTerminal).not.toHaveBeenCalled();
    registry.setContext(terminal);
    disposeChat();
    registry.dispatch('app.find');
    expect(findTerminal).toHaveBeenCalledTimes(1);
    registry.setContext(chat);
    expect(registry.dispatch('app.find')).toBe(false);
  });

  it('uses the most specific enabled handler and passes the explicitly targeted task', () => {
    const registry = new CommandRegistry();
    const rename = vi.fn();
    registry.register({ scopeId: 'app', getCommands: () => [{ id: 'session.rename', execute: rename }] });
    const unavailable = vi.fn();
    const dispose = registry.register({ scopeId: 'session-sub', getCommands: () => [{ id: 'session.rename', enabled: false, execute: unavailable }] });
    const task = { projectId: 'project-2', sessionId: 'task-9' };
    registry.dispatch('session.rename', task);
    expect(rename).toHaveBeenCalledWith(task);
    expect(unavailable).not.toHaveBeenCalled();
    dispose();
    registry.dispatch('session.rename');
    expect(rename).toHaveBeenCalledTimes(2);
  });
  it('does not claim an action when its target cannot handle it', () => {
    const registry = new CommandRegistry();
    registry.register({ scopeId: 'app', getCommands: () => [{ id: 'session.rename', execute: () => false }] });
    expect(registry.dispatch('session.rename')).toBe(false);
  });

});
