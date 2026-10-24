import { makeAutoObservable, observable } from 'mobx';
import type { CommandId } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { SCOPE_LEVELS, type AppCommand, type CommandProvider, type ScopeId } from './types';

export class CommandRegistry {
  private providers = new Set<CommandProvider>();
  contextElement: HTMLElement | null = null;
  shortcutsPaused = false;

  constructor() {
    makeAutoObservable<this, 'providers'>(this, { providers: observable.shallow, contextElement: observable.ref });
  }

  register(provider: CommandProvider): () => void {
    this.providers.add(provider);
    return () => { this.providers.delete(provider); };
  }

  setShortcutsPaused(paused: boolean): void {
    this.shortcutsPaused = paused;
  }

  unregister(scopeId: ScopeId): void {
    for (const provider of this.providers) {
      if (provider.scopeId === scopeId) this.providers.delete(provider);
    }
  }

  setContext(element: HTMLElement): void {
    if (!element.closest('[role="menu"], [cmdk-root]')) {
      this.contextElement = element;
    }
  }

  dispatch(id: CommandId, task?: { projectId: string; sessionId: string }): boolean {
    const command = this.activeCommands.find((item) => item.id === id && item.enabled !== false);
    if (!command) return false;
    return command.execute(task) !== false;
  }

  get activeCommands(): AppCommand[] {
    const providers = [...this.providers].sort((a, b) => SCOPE_LEVELS[b.scopeId] - SCOPE_LEVELS[a.scopeId]);
    return providers.filter((provider) => !provider.isActive || provider.isActive(this.contextElement))
      .flatMap((provider) => provider.getCommands());
  }
}

export const commandRegistry = new CommandRegistry();
