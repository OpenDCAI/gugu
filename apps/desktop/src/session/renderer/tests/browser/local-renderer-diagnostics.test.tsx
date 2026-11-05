import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { installLocalRendererDiagnostics } from '@/lib/localRendererDiagnostics';
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import type { DiagnosticFields } from '../../../../../shared/local-renderer-diagnostics';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: undefined }) }));

let root: Root;
let host: HTMLDivElement;
let rows: DiagnosticFields[];
let descriptors: Array<[string, PropertyDescriptor | undefined]>;

beforeEach(() => {
  rows = [];
  descriptors = ['electronAPI', 'desktopWindow'].map(key => [key, Object.getOwnPropertyDescriptor(window, key)]);
  Object.defineProperty(window, 'desktopWindow', { configurable: true, value: {} });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke: async (channel: string, payload: { scope?: string; fields?: DiagnosticFields }) => {
    if (channel === 'log:write' && payload?.scope === 'local-diagnostics' && payload.fields) rows.push(payload.fields);
  } } });
  installLocalRendererDiagnostics();
  modalStore.closeModal();
  host = document.createElement('div');
  host.className = 'gugu-skin emlight';
  document.body.append(host);
  root = createRoot(host);
  root.render(<QueryClientProvider client={new QueryClient()}><SessionLocalizationProvider><ModalRenderer /></SessionLocalizationProvider></QueryClientProvider>);
});

afterEach(() => {
  window.dispatchEvent(new PageTransitionEvent('pagehide'));
  modalStore.closeModal();
  root.unmount();
  host.remove();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(window, key, descriptor);
    else Reflect.deleteProperty(window, key);
  }
});

const open = async () => {
  const onClose = vi.fn(() => modalStore.closeModal('dismissed'));
  modalStore.setModal('confirmActionModal', { title: 'PRIVATE TITLE NOT FOR LOGS', description: 'PRIVATE MESSAGE NOT FOR LOGS', confirmLabel: 'Confirm', variant: 'default', onSuccess: () => undefined, onClose });
  await until('real Base UI dialog is mounted', () => document.querySelector('[role="dialog"], [role="alertdialog"]') !== null);
  return onClose;
};

it('records the actual Escape owner and closure through the real modal without logging its content', async () => {
  const onClose = await open();
  await userEvent.keyboard('{Escape}');
  await until('actual modal closes', () => !modalStore.isOpen);
  await until('Escape observation is delivered', () => rows.some(row => row.event === 'escape'));
  expect(onClose).toHaveBeenCalledOnce();
  const escape = rows.find(row => row.event === 'escape')!;
  expect(escape.handledBy).toEqual(expect.arrayContaining(['session-dialog', 'session-modal']));
  expect(escape.decisions).toContain('close-requested');
  expect(JSON.stringify(rows)).not.toContain('PRIVATE');
});

it('records the close guard while preserving the open dialog, then still permits a later Escape', async () => {
  const onClose = await open();
  modalStore.closeGuardActive = true;
  await userEvent.keyboard('{Escape}');
  await until('guarded Escape is observed', () => rows.some(row => row.event === 'escape'));
  expect(modalStore.isOpen).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  expect(rows.find(row => row.event === 'escape')?.decisions).toContain('blocked-close-guard');
  modalStore.closeGuardActive = false;
  await userEvent.keyboard('{Escape}');
  await until('second Escape closes the real modal', () => !modalStore.isOpen);
  expect(onClose).toHaveBeenCalledOnce();
});
