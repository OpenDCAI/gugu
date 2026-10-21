/**
 * Esc / 点外面关掉弹窗,走的是这个弹窗自己的 onClose。
 *
 * 从前 modal-renderer 在这两种关法下只清 store、不调 onClose:画面没了,等结果的调用方却什么也没听到。
 * agent 的 app_install 在等的安装同意框因此挂满 280 秒才拿到 timeout;另存为、远端传输的确认在
 * onClose 里 resolve(false),Esc 之后那个 promise 永远不落定。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: undefined }),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  host.className = 'gugu-skin emlight';
  document.body.append(host);
  root = createRoot(host);
  modalStore.closeModal();
});

afterEach(() => {
  modalStore.closeModal();
  root.unmount();
  host.remove();
});

it('Esc closes a modal through its own onClose, so whoever is waiting on it hears', async () => {
  root.render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionLocalizationProvider>
        <ModalRenderer />
      </SessionLocalizationProvider>
    </QueryClientProvider>
  );
  const onClose = vi.fn(() => modalStore.closeModal('dismissed'));
  modalStore.setModal('confirmActionModal', {
    title: 'Install Pomodoro?',
    description: 'Give the agents on this computer its tools',
    confirmLabel: 'Install',
    variant: 'default',
    onSuccess: () => undefined,
    onClose,
  });
  await until('the dialog is open', () => document.querySelector('[role="dialog"], [role="alertdialog"]') !== null);

  await userEvent.keyboard('{Escape}');

  await until('the modal is closed', () => !modalStore.isOpen);
  expect(onClose).toHaveBeenCalledTimes(1);
});
