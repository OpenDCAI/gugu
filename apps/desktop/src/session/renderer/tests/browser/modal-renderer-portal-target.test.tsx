/**
 * modalStore 的弹窗由本页 App 里那一个 ModalRenderer 画。壳的设置弹窗画着会话页那几格时(product spec),
 * 浏览器页「清除数据」这类确认框要落进设置弹窗里面 —— 落在本页的浮层层里就被压在设置弹窗底下,点不到。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UiPortalContainerProvider } from '@gugu/session-ui/react/primitives';
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
let pageLayer: HTMLDivElement;
let settingsLayer: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  pageLayer = document.createElement('div');
  settingsLayer = document.createElement('div');
  for (const el of [host, pageLayer, settingsLayer]) {
    el.className = 'gugu-skin emlight';
    document.body.append(el);
  }
  root = createRoot(host);
  root.render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionLocalizationProvider>
        <UiPortalContainerProvider value={pageLayer}>
          <ModalRenderer />
        </UiPortalContainerProvider>
      </SessionLocalizationProvider>
    </QueryClientProvider>
  );
  modalStore.closeModal();
});

afterEach(() => {
  modalStore.closeModal();
  modalStore.setPortalContainer(null);
  root.unmount();
  for (const el of [host, pageLayer, settingsLayer]) el.remove();
});

function confirm() {
  modalStore.setModal('confirmActionModal', {
    title: 'Delete 3 tasks?',
    description: 'Their folders are removed from this machine',
    confirmLabel: 'Delete',
    variant: 'default',
    onSuccess: () => undefined,
    onClose: () => modalStore.closeModal('dismissed'),
  });
}

const dialogsIn = (el: HTMLElement) => el.querySelectorAll('[role="dialog"], [role="alertdialog"]').length;

it('lands inside the settings modal while it shows the task sections', async () => {
  modalStore.setPortalContainer(settingsLayer);
  confirm();
  await until('the dialog is open', () => dialogsIn(settingsLayer) > 0);
  expect(dialogsIn(settingsLayer)).toBe(1);
  expect(dialogsIn(pageLayer)).toBe(0);
});

it('lands in the page layer otherwise', async () => {
  // 阳控:同一套判据在没有设置弹窗时必须在本页的层里读到它 —— 否则「没落进设置」与「谁都没画」同形。
  confirm();
  await until('the dialog is open', () => dialogsIn(pageLayer) > 0);
  expect(dialogsIn(pageLayer)).toBe(1);
  expect(dialogsIn(settingsLayer)).toBe(0);
});
