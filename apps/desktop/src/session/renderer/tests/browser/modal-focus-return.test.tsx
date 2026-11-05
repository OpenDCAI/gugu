/**
 * @@@modal-focus-return — 弹窗关掉(Esc / 点外面 / 取消)把焦点还给打开它的元素;弹窗做完了事(回车选了结果、确认了)不还。
 *
 * 从前做完了事也还:搜索框回车打开一条结果,人已经在那条对话里了,侧栏的「搜索…」框却带着键盘焦点环(蓝框)一直挂着
 * —— 最后一下是键盘,Chromium 给程序还回去的焦点判 :focus-visible。键盘关掉时那圈环是无障碍要的,照样要有。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: undefined }),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  host = document.createElement('div');
  host.className = 'gugu-skin emlight';
  document.body.append(host);
  root = createRoot(host);
  modalStore.closeModal();
  root.render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionLocalizationProvider>
        <button type="button" data-testid="opener" onClick={() => showModal('confirmActionModal', {
          title: 'Open this?', description: 'A result', confirmLabel: 'Open', cancelLabel: 'Back', variant: 'default',
        })}>Search…</button>
        <ModalRenderer />
      </SessionLocalizationProvider>
    </QueryClientProvider>
  );
  await until('the opener is mounted', () => opener() !== null);
});

afterEach(() => {
  modalStore.closeModal();
  root.unmount();
  host.remove();
});

const opener = () => document.querySelector<HTMLButtonElement>('[data-testid="opener"]');
const dialogButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-content"] button')].find((b) => b.textContent?.startsWith(label)) ?? null;
const frames = (n: number) => new Promise<void>((resolve) => {
  const step = (left: number) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
  step(n);
});

async function openWithMouse() {
  await userEvent.click(page.getByTestId('opener'));
  await until('the dialog is open', () => dialogButton('Open') !== null);
}

it('a keyboard dismissal (Esc) gives focus back to the opener, ring and all', async () => {
  await openWithMouse();
  await userEvent.keyboard('{Escape}');
  await until('focus is back on the opener', () => document.activeElement === opener());
  expect(opener()!.matches(':focus-visible')).toBe(true);
});

it('a mouse dismissal gives focus back to the opener without a ring', async () => {
  await openWithMouse();
  await userEvent.click(dialogButton('Back')!);
  await until('focus is back on the opener', () => document.activeElement === opener());
  expect(opener()!.matches(':focus-visible')).toBe(false);
});

it('finishing the modal with the keyboard leaves focus to where the action went, not on the opener', async () => {
  await openWithMouse();
  dialogButton('Open')!.focus();
  await userEvent.keyboard('{Enter}');
  await until('the modal is closed', () => !modalStore.isOpen);
  await frames(5);
  expect(document.activeElement).not.toBe(opener());
  expect(opener()!.matches(':focus-visible')).toBe(false);
});
