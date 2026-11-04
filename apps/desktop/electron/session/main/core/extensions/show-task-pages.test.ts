import { expect, it, vi } from 'vitest';
import type { BridgeCaller } from './extension-bridge';
import { showTaskPages } from './show-task-pages';
const from = (stop = new AbortController()) => ({ kind: 'program', pageId: -1, extensionId: 'own-app', callingSession: 'bound-task', signal: stop.signal }) as BridgeCaller;
it('opens only the calling task’s own declared App pages through the ordinary pane opener', async () => {
  const caller = from(), open = vi.fn(async () => ['own-app.preview']), projectOf = vi.fn(async () => 'bound-project');
  await expect(showTaskPages(caller, { authorize: vi.fn(), projectOf, open })).resolves.toEqual(['own-app.preview']);
  expect(projectOf).toHaveBeenCalledWith('bound-task');
  expect(open).toHaveBeenCalledWith({ projectId: 'bound-project', sessionId: 'bound-task' }, 'own-app', caller.signal);
});
it('requires a live program task, and cancellation or withdrawal during lookup never opens a page', async () => {
  const stop = new AbortController(), open = vi.fn(async () => []), lookup = Promise.withResolvers<string>();
  const deps = { authorize: vi.fn(), projectOf: vi.fn(() => lookup.promise), open };
  for (const caller of [{ ...from(), kind: 'page' }, { ...from(), callingSession: undefined }, { ...from(), signal: undefined }]) {
    await expect(showTaskPages(caller as BridgeCaller, deps)).rejects.toThrow('current task');
  }
  const pending = showTaskPages(from(stop), deps);
  stop.abort(); lookup.resolve('project');
  await expect(pending).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  await expect(showTaskPages(from(), { ...deps, authorize: () => { throw new Error('revoked'); } })).rejects.toThrow('revoked');
  expect(open).not.toHaveBeenCalled();
});
