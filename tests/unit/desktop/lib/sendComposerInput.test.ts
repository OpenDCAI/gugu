import { expect, it, vi } from 'vitest';
import { sendComposerInput } from '../../../../apps/desktop/src/session/renderer/features/sessions/acp/send-composer-input';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(value = 'submitted words') {
  const commit = deferred();
  let draft = value;
  const port = {
    unsettled: vi.fn(() => false), waitForUploads: vi.fn(async () => {}),
    hasFailedAttachments: vi.fn(() => false), files: vi.fn(() => []), status: vi.fn(),
    deliver: vi.fn(() => commit.promise),
    committed: vi.fn(() => { if (draft === value) draft = ''; }),
  };
  return { port, commit, draft: () => draft, type: (next: string) => { draft = next; }, value };
}

it.each(['submitted words', 'submitted words and more', 'rewritten draft'])('a failed durable send retains the current draft: %s', async next => {
  const f = fixture();
  const sending = sendComposerInput(f.value, f.port);
  expect(f.port.deliver).toHaveBeenCalledOnce();
  expect(f.draft()).toBe(f.value);
  f.type(next);
  f.commit.reject(new Error('storage refused'));
  await sending;
  expect(f.draft()).toBe(next);
  expect(f.port.committed).not.toHaveBeenCalled();
});

it('a failed upload never commits or overwrites edits made while waiting', async () => {
  const f = fixture(), upload = deferred();
  f.port.unsettled.mockReturnValueOnce(true).mockReturnValue(false);
  f.port.waitForUploads.mockReturnValue(upload.promise);
  f.port.hasFailedAttachments.mockReturnValue(true);
  const sending = sendComposerInput(f.value, f.port);
  expect(f.port.status).toHaveBeenCalledExactlyOnceWith('waiting');
  f.type('new draft while uploading'); upload.resolve(); await sending;
  expect(f.draft()).toBe('new draft while uploading');
  expect(f.port.status).toHaveBeenLastCalledWith('blocked');
  expect(f.port.deliver).not.toHaveBeenCalled();
  expect(f.port.committed).not.toHaveBeenCalled();
});

it.each(['submitted words', 'the next draft'])('only successful persistence commits the submitted draft: %s', async next => {
  const f = fixture();
  const sending = sendComposerInput(f.value, f.port);
  f.type(next);
  expect(f.port.committed).not.toHaveBeenCalled();
  f.commit.resolve(); await sending;
  expect(f.port.committed).toHaveBeenCalledOnce();
  expect(f.draft()).toBe(next === f.value ? '' : next);
});

it('chooses local-send following before waiting and never reselects it over a later reading gesture', async () => {
  const f = fixture(), upload = deferred(), events: string[] = [];
  const started = vi.fn(() => { events.push('follow'); });
  f.port.unsettled.mockReturnValueOnce(true).mockReturnValue(false);
  f.port.waitForUploads.mockReturnValue(upload.promise);
  const sending = sendComposerInput(f.value, { ...f.port, started });
  expect(events).toEqual(['follow']);
  events.push('reader-up');
  upload.resolve();
  await Promise.resolve();
  f.commit.resolve();
  await sending;
  expect(started).toHaveBeenCalledOnce();
  expect(events).toEqual(['follow', 'reader-up']);
});

it('an empty composer cannot authorize following', async () => {
  const f = fixture(''), started = vi.fn();
  await sendComposerInput('', { ...f.port, started });
  expect(started).not.toHaveBeenCalled();
  expect(f.port.deliver).not.toHaveBeenCalled();
});
