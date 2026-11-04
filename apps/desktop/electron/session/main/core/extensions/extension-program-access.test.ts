import { expect, it } from 'vitest';
import { cancelExtensionSessionCalls, openExtensionProgramAccess, revokeExtensionProgramAccess, withExtensionProgramAccess } from './extension-program-access';

it('rejects a result when its caller cancels just as the operation resolves', async () => {
  const parent = new AbortController();
  const reason = new Error('caller stopped before receiving the result');
  await expect(withExtensionProgramAccess('result-race-app', parent.signal, async () => {
    parent.abort(reason);
    return 'late result';
  })).rejects.toBe(reason);
});

it('single-call cancellation waits for its authority cleanup before answering the caller', async () => {
  const parent = new AbortController();
  const cleanup = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let outcome = 'pending';
  const call = withExtensionProgramAccess('cleanup-app', parent.signal, async (signal) => {
    try {
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        entered.resolve();
      });
    } finally { await cleanup.promise; }
  }).then(() => { outcome = 'completed'; }, () => { outcome = 'interrupted'; });
  try {
    await entered.promise;
    parent.abort();
    await new Promise(resolve => setImmediate(resolve));
    expect(outcome).toBe('pending');
  } finally {
    cleanup.resolve();
    await call;
  }
  expect(outcome).toBe('interrupted');
});

it('a late resource release cannot detach the re-enabled App from the next revocation', () => {
  const old = openExtensionProgramAccess('resource-app');
  revokeExtensionProgramAccess('resource-app');
  expect(old.signal.aborted).toBe(true);
  const current = openExtensionProgramAccess('resource-app');
  const other = openExtensionProgramAccess('other-resource-app');
  try {
    old.release();
    revokeExtensionProgramAccess('resource-app');
    expect(current.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
  } finally {
    current.release();
    other.release();
  }
});

it('a single resource cancellation does not revoke other resources of the App', () => {
  const parent = new AbortController();
  const one = openExtensionProgramAccess('resource-caller', parent.signal);
  const two = openExtensionProgramAccess('resource-caller');
  try {
    parent.abort();
    expect(one.signal.aborted).toBe(true);
    expect(two.signal.aborted).toBe(false);
    one.release();
    revokeExtensionProgramAccess('resource-caller');
    expect(two.signal.aborted).toBe(true);
  } finally {
    one.release();
    two.release();
  }
});

it('a task stop cancels its calls across Apps without revoking other tasks or the person', () => {
  const first = openExtensionProgramAccess('shared-app', undefined, 'task-a');
  const second = openExtensionProgramAccess('second-app', undefined, 'task-a');
  const otherTask = openExtensionProgramAccess('shared-app', undefined, 'task-b');
  const person = openExtensionProgramAccess('shared-app');
  try {
    cancelExtensionSessionCalls('task-a');
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(otherTask.signal.aborted).toBe(false);
    expect(person.signal.aborted).toBe(false);
    revokeExtensionProgramAccess('shared-app');
    expect(otherTask.signal.aborted).toBe(true);
    expect(person.signal.aborted).toBe(true);
  } finally {
    first.release(); second.release(); otherTask.release(); person.release();
  }
});

it('late cleanup from an interrupted turn cannot detach a newer turn from cancellation', () => {
  const old = openExtensionProgramAccess('turn-app', undefined, 'task-turns');
  cancelExtensionSessionCalls('task-turns');
  const current = openExtensionProgramAccess('turn-app', undefined, 'task-turns');
  try {
    old.release();
    expect(current.signal.aborted).toBe(false);
    cancelExtensionSessionCalls('task-turns');
    expect(current.signal.aborted).toBe(true);
  } finally { old.release(); current.release(); }
});

it('task cancellation waits for that call to release authority, while a newer turn proceeds', async () => {
  const entered = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  let outcome = 'pending';
  const old = withExtensionProgramAccess('slow-cleanup', undefined, async signal => {
    try {
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        entered.resolve();
      });
    } finally { await cleanup.promise; }
  }, 'task-cleanup').then(() => { outcome = 'completed'; }, () => { outcome = 'interrupted'; });
  try {
    await entered.promise;
    cancelExtensionSessionCalls('task-cleanup');
    await new Promise(resolve => setImmediate(resolve));
    expect(outcome).toBe('pending');
    await expect(withExtensionProgramAccess('slow-cleanup', undefined, async signal => {
      expect(signal.aborted).toBe(false);
      return 'new turn';
    }, 'task-cleanup')).resolves.toBe('new turn');
  } finally { cleanup.resolve(); await old; }
  expect(outcome).toBe('interrupted');
});
