import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAppSettingValueSnapshot: vi.fn(),
  setAppSettingsValueInCache: vi.fn(),
  updateAppSettingsRequest: vi.fn(() => Promise.resolve()),
  showModal: vi.fn(),
}));

vi.mock('@renderer/features/settings/app-settings-client', () => ({
  getAppSettingValueSnapshot: mocks.getAppSettingValueSnapshot,
  setAppSettingsValueInCache: mocks.setAppSettingsValueInCache,
  updateAppSettingsRequest: mocks.updateAppSettingsRequest,
  invalidateAppSettingsKey: vi.fn(),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ showModal: mocks.showModal }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@renderer/localization/locale-store', () => ({
  translateSessionMessage: (key: string) => key,
}));
vi.mock('@renderer/utils/logger', () => ({ log: { error: vi.fn() } }));

import { requestSendQueuedPromptNow } from './send-queued-prompt-now-flow';

type ModalArgs = {
  dontAskAgainLabel?: string;
  onSuccess: (r: { dontAskAgain: boolean; scopeChecked: boolean }) => void;
};
const lastModal = () => mocks.showModal.mock.calls.at(-1)?.[1] as ModalArgs;

describe('requestSendQueuedPromptNow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends straight away when no turn is running', () => {
    mocks.getAppSettingValueSnapshot.mockReturnValue({ confirmBeforeCancelAndSend: true });
    const send = vi.fn();
    requestSendQueuedPromptNow({ cancelsTurn: false, send });
    expect(send).toHaveBeenCalledOnce();
    expect(mocks.showModal).not.toHaveBeenCalled();
  });

  it('asks first while a turn is running, and offers "don\'t ask again"', () => {
    mocks.getAppSettingValueSnapshot.mockReturnValue({ confirmBeforeCancelAndSend: true });
    const send = vi.fn();
    requestSendQueuedPromptNow({ cancelsTurn: true, send });
    expect(send).not.toHaveBeenCalled();
    expect(lastModal().dontAskAgainLabel).toBe('chat.cancelAndSendDontAskAgain');
    lastModal().onSuccess({ dontAskAgain: false, scopeChecked: false });
    expect(send).toHaveBeenCalledOnce();
    expect(mocks.updateAppSettingsRequest).not.toHaveBeenCalled();
  });

  it('ticking "don\'t ask again" turns the setting off and still sends', () => {
    const current = { confirmBeforeArchive: true, confirmBeforeCancelAndSend: true };
    mocks.getAppSettingValueSnapshot.mockReturnValue(current);
    const send = vi.fn();
    requestSendQueuedPromptNow({ cancelsTurn: true, send });
    lastModal().onSuccess({ dontAskAgain: true, scopeChecked: false });
    expect(mocks.updateAppSettingsRequest).toHaveBeenCalledWith('interface', {
      ...current,
      confirmBeforeCancelAndSend: false,
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it('skips the dialog once the setting is off', () => {
    mocks.getAppSettingValueSnapshot.mockReturnValue({ confirmBeforeCancelAndSend: false });
    const send = vi.fn();
    requestSendQueuedPromptNow({ cancelsTurn: true, send });
    expect(mocks.showModal).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  // 读不到偏好时按「问」走,且不摆一个勾了也写不进去的复选框。
  it('asks without the checkbox while settings are not loaded', () => {
    mocks.getAppSettingValueSnapshot.mockReturnValue(undefined);
    const send = vi.fn();
    requestSendQueuedPromptNow({ cancelsTurn: true, send });
    expect(send).not.toHaveBeenCalled();
    expect(lastModal().dontAskAgainLabel).toBeUndefined();
  });
});
