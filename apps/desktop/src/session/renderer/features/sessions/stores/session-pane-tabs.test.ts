import { describe, expect, it, vi } from 'vitest';
import { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store';
import { createTabProvider, createTabRegistry } from '@renderer/features/tabs/core/tab-provider-registry';
import { closeSessionPaneTab, sessionPaneTabs } from './session-pane-tabs';

vi.mock('./session-selectors', () => ({}));
vi.mock('@renderer/utils/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

function setup() {
  const confirm = vi.fn<() => boolean | Promise<boolean>>(() => true);
  const dispose = vi.fn();
  const provider = (kind: string) => createTabProvider({
    kind,
    resourceKey: (state: { path: string }) => state.path,
    initialize: (entry) => ({ title: entry.state.path, dispose }),
    dispose: () => {},
    onBeforeClose: confirm,
    TabBarItem: () => null,
    TabBarItemDragPreview: () => null,
    TabContent: () => null,
  });
  const layout = new PaneLayoutStore(createTabRegistry([provider('file'), provider('session'), provider('acp-chat'), provider('side-chat')]), { viewId: 'task-1' });
  const add = (kind: string, path: string, preview = false) => {
    layout.open(kind, { path }, { preview });
    return sessionPaneTabs(layout).find((tab) => tab.title === path)!.tab_id;
  };
  return { layout, add, confirm, dispose };
}

describe('the calling task live tabs', () => {
  it('counts reused previews once and includes detached-window tabs', () => {
    const { layout, add } = setup();
    add('session', 'Conversation');
    add('file', 'draft.html', true);
    const final = add('file', 'final.html', true);
    expect(sessionPaneTabs(layout).map((tab) => tab.title)).toEqual(['Conversation', 'final.html']);
    expect(layout.detachToWindow(final)).not.toBeNull();
    expect(sessionPaneTabs(layout)).toContainEqual({ tab_id: final, title: 'final.html', kind: 'file', closable: true });
    expect(sessionPaneTabs(layout)).toHaveLength(2);
    layout.dispose();
  });

  it('awaits the real close veto and reports false when the person keeps the unsaved file', async () => {
    const { layout, add, confirm } = setup();
    const id = add('file', 'unsaved.html');
    let decide!: (yes: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise((resolve) => { decide = resolve; }));
    const closing = closeSessionPaneTab(layout, id);
    expect(sessionPaneTabs(layout)).toHaveLength(1);
    decide(false);
    expect(await closing).toMatchObject({ closed: false, tabs: [{ tab_id: id }] });
    expect((await closeSessionPaneTab(layout, id)).closed).toBe(true);
    expect(sessionPaneTabs(layout)).toEqual([]);
    layout.dispose();
  });

  it('protects conversation tabs and cannot close a tab belonging to another task', async () => {
    const one = setup();
    const other = setup();
    const otherId = other.add('file', 'other-task.html');
    await expect(closeSessionPaneTab(one.layout, otherId)).rejects.toThrow('in this task');
    for (const kind of ['session', 'acp-chat', 'side-chat']) {
      const id = one.add(kind, kind);
      expect(sessionPaneTabs(one.layout).find((tab) => tab.tab_id === id)?.closable).toBe(false);
      await expect(closeSessionPaneTab(one.layout, id)).rejects.toThrow('conversation tab');
    }
    expect(one.confirm).not.toHaveBeenCalled();
    expect(sessionPaneTabs(other.layout)).toHaveLength(1);
    one.layout.dispose(); other.layout.dispose();
  });
});
