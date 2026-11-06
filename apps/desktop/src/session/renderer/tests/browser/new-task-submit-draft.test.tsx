import { ChatComposer, type ComposerAttachment, type PromptEditorRef } from '@gugu/session-ui/react/components';
import { act, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { useCreateSessionCallback } from '@renderer/features/sessions/create-session-modal/use-create-session-callback';
import { CreateDeliveryError } from '@renderer/features/sessions/create-session-modal/create-delivery-error';
import type { CreateSessionState } from '@renderer/features/sessions/create-session-modal/use-create-session-state';
import type { InitialSessionState } from '@renderer/features/sessions/session-config/initial-session-section';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { NoticeHost } from '@/components/NoticeHost';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@renderer/index.css';

const mocks = vi.hoisted(() => ({ create: vi.fn(), assertProtocol: vi.fn(), navigate: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionManagerStore: () => ({ createSession: mocks.create }), getSessionPageStore: () => ({ workspaceId: 'workspace' }), asProvisioned: (value: unknown) => value,
}));
vi.mock('@/store/devicesCache', () => ({ readCachedDevices: () => [{ device_id: 'host', capabilities: { remote_protocol: 15 } }] }));
vi.mock('@/lib/taskAttachmentTarget', async original => ({ ...(await original<object>()), assertTaskAttachmentProtocol: mocks.assertProtocol, taskAttachmentUsesSsh: () => false }));
vi.mock('@renderer/lib/ipc', async original => ({ ...(await original<object>()), rpc: { sessions: { sendMessage: vi.fn() } }, rpcOn: () => ({ sessionCreate: { admitFirstMessages: async () => {} } }) }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: mocks.warn, error: mocks.error } }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));

const ref = { itemId: 'brief', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 };
const creation = { isValid: true, linkedType: null, linkedIssue: null, sessionName: { effectiveSessionName: 'task' }, workspaceConfig: { resolvedConfig: { version: '2' } } } as unknown as CreateSessionState;

function Harness() {
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([{ id: 'file', name: ref.name, kind: 'file' }]);
  const [attachmentEditSeq, setEditSeq] = useState(0);
  const editor = useRef<PromptEditorRef | null>(null);
  const initial = {
    prompt, setPrompt, attachments, attachmentEditSeq, provider: 'codex', providerError: null, permissionMode: 'full-access',
    sessionView: 'general', sessionpage: { acp: { identity: 'addressable', messageTransport: 'router' } },
    promptCapability: { kind: 'none', startupDelivery: 'startup-prompt' },
    prepareAttachments: async () => [ref], placeAttachments: async () => [ref], pendingAttachmentFiles: () => [],
    rememberStartedConfiguration: async () => {},
  } as unknown as InitialSessionState;
  const { handleCreateSession, canCreate, deliveryError } = useCreateSessionCallback({
    selectedProjectId: 'project-1', state: creation, initialSession: initial, navigate: mocks.navigate, onClose: () => {},
  });
  useEffect(() => {
    if (editor.current?.getText() !== prompt) editor.current?.setText(prompt);
  }, [prompt]);
  return <>
    <NoticeHost />
    <ChatComposer editorOptions={{ clearOnSubmit: false }} editorApiRef={editor} onInputChange={setPrompt}
      onSubmit={handleCreateSession} canSubmit={canCreate} attachments={attachments}
      onAttachmentsChange={next => { setAttachments(next); setEditSeq(seq => seq + 1); }} />
    <CreateDeliveryError failure={deliveryError} />
  </>;
}

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.create.mockImplementation(async (_params: unknown, options?: { onOptimistic?: () => void }) => { options?.onOptimistic?.(); });
  mocks.assertProtocol.mockReset();
  machineRegistry.register('host', ['project-1']);
  await page.viewport(900, 700);
  container = document.createElement('div');
  container.className = 'emlight gugu-skin';
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<SessionLocalizationProvider><Harness /></SessionLocalizationProvider>));
  await page.getByTestId('prompt-editor').click();
  await userEvent.keyboard('keep this draft');
});
afterEach(() => { act(() => root.unmount()); container.remove(); machineRegistry.forgetMachine('host'); });
const text = () => container.querySelector('[data-testid="prompt-editor"]')?.textContent;

it.each(['Enter', 'button'])('keeps the draft, file chip and visible update error after rejected %s submission', async method => {
  const detail = 'task attachment protocol mismatch: received=15 required=17';
  mocks.assertProtocol.mockImplementation(() => { throw new Error(detail); });
  if (method === 'Enter') await userEvent.keyboard('{Enter}');
  else await page.getByRole('button', { name: translateSessionMessage('composer.sendMessage'), exact: true }).click();
  const message = translateSessionMessage('composer.attachmentHostUpdateRequired');
  await expect.element(page.getByText(message, { exact: true })).toBeVisible();
  expect(container.querySelector('[data-testid="create-delivery-error"]')).toBeNull();
  expect(document.body.textContent).not.toContain(detail);
  expect(mocks.warn).toHaveBeenCalledWith('Attachment protocol check failed', { machineId: 'host', error: detail });
  expect(text()).toBe('keep this draft');
  expect(container.textContent).toContain('brief.txt');
  expect(mocks.create).not.toHaveBeenCalled();
  await page.getByRole('button', { name: translateSessionMessage('composer.removeAttachment', { name: 'brief.txt' }), exact: true }).click();
  await until('editing the attachments clears the obsolete refusal', () => document.querySelector('[data-sonner-toast]') === null);
  await page.getByTestId('prompt-editor').click();
  await userEvent.keyboard('{Enter}');
  await until('the retained caption creates one task', () => mocks.navigate.mock.calls.length === 1 && text() === '');
  await act(async () => {});
  expect(mocks.create).toHaveBeenCalledOnce();
  expect(text()).toBe('');
  expect(mocks.create.mock.calls[0]?.[0].sessionConfig.initialSession.initialQueue[0].text).toBe('keep this draft');
});

it('navigates immediately and retains the pending draft while a slow creation finishes', async () => {
  let finish!: () => void;
  mocks.create.mockImplementationOnce((_params: unknown, options?: { onOptimistic?: () => void }) => {
    options?.onOptimistic?.();
    return new Promise<void>(resolve => { finish = resolve; });
  });
  await userEvent.keyboard('{Enter}');
  await until('creation has started', () => mocks.create.mock.calls.length === 1);
  expect(mocks.navigate).toHaveBeenCalledOnce();
  expect(text()).toBe('keep this draft');
  await expect.element(page.getByRole('button', { name: translateSessionMessage('composer.sendMessage'), exact: true })).toBeDisabled();
  await act(async () => finish());
  await until('creation finishes', () => text() === '');
  await act(async () => {});
  expect(text()).toBe('');
  expect(mocks.navigate).toHaveBeenCalledOnce();
});
