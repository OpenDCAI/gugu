import { expect, it, vi } from 'vitest';
import { page } from './test-support/page-protocol-fixture';
import { leasePageProtocol } from './leased-page-protocol';

it('cancellation while restoration is pending cannot dispatch a late native input or attach a debugger', async () => {
  const selected = page(), ready = Promise.withResolvers<void>();
  const lease = leasePageProtocol(selected.contents, { ready: ready.promise, capture: vi.fn() });
  const command = lease.protocol.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift' });
  const rejected = expect(command).rejects.toThrow('lease ended');
  await lease.cleanup(); ready.resolve(); await rejected;
  await Promise.resolve();
  expect(selected.debuggerApi.attach).not.toHaveBeenCalled();
  expect(selected.debuggerApi.sendCommand).not.toHaveBeenCalled();
  lease.protocol.close();
});
it('an uncertain native down is followed by exactly one release before detach, without replaying the down', async () => {
  const selected = page(), nativeDown = Promise.withResolvers<unknown>();
  selected.debuggerApi.sendCommand.mockImplementationOnce(() => nativeDown.promise);
  const lease = leasePageProtocol(selected.contents, { ready: Promise.resolve(), capture: vi.fn() });
  const command = lease.protocol.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft' });
  const rejected = expect(command).rejects.toThrow('lease ended');
  await vi.waitFor(() => expect(selected.debuggerApi.sendCommand).toHaveBeenCalledTimes(1));
  await Promise.all([lease.cleanup(), lease.cleanup()]); await rejected;
  expect(selected.debuggerApi.sendCommand.mock.calls).toEqual([
    ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft' }, undefined],
    ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', modifiers: 0 }, undefined],
  ]);
  expect(selected.debuggerApi.detach).not.toHaveBeenCalled();
  lease.protocol.close(); expect(selected.debuggerApi.detach).toHaveBeenCalledTimes(1);
  expect(selected.contents.close).not.toHaveBeenCalled();
  nativeDown.resolve({});
});
