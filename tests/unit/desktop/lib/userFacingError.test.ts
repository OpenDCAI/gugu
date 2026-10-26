import { beforeEach, describe, expect, it, vi } from 'vitest';
const translate = vi.hoisted(() => vi.fn(() => 'The connection to the machine was lost. Try again when it reconnects.'));
vi.mock('../../../../apps/desktop/src/session/renderer/localization/locale-store', () => ({ translateSessionMessage: translate }));
import { messageForUser } from '../../../../apps/desktop/src/lib/userFacingError';
beforeEach(() => translate.mockClear());

describe('the shared user-facing failure exit', () => {
  it('explains a disconnected history transport after removing the IPC wrapper', () => {
    expect(messageForUser(new Error("Error invoking remote method 'history': Error: Wire transport disconnected\ncode=DISCONNECTED")))
      .toBe('The connection to the machine was lost. Try again when it reconnects.');
    expect(translate).toHaveBeenCalledExactlyOnceWith('taskError.connectionLost');
  });
  it('preserves the cause while redacting paths, tokens and subsequent lines', () => {
    expect(messageForUser(new Error('Permission denied for /Users/alice/private.txt with sk-test_secret\nprivate stack')))
      .toBe('Permission denied for [path] with [redacted token]');
    expect(translate).not.toHaveBeenCalled();
  });
  it('leaves cancellation and provider causes specific', () => {
    expect(messageForUser(new Error('Wire call cancelled'))).toBe('Wire call cancelled');
    expect(messageForUser(new Error('Provider refused this model'))).toBe('Provider refused this model');
    expect(translate).not.toHaveBeenCalled();
  });
});
