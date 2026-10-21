import { createRoot, type Root } from 'react-dom/client';
import { createRef } from 'react';
import { observer } from 'mobx-react-lite';
import { runInAction } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ChatComposer, MessageProvider, type PromptEditorRef } from '@gugu/session-ui/react/components';
import { registerSessionLocaleResources, translateSessionMessage } from '@renderer/localization/locale-store';
import '@renderer/index.css';
import { until } from '../../../../../../../tests/support/awaitCondition';

const queuePrompt = vi.fn().mockResolvedValue({ success: true, data: { queued: true } });
vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({ queuePrompt }),
}));

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: { invoke: async () => [], eventOn: () => () => {}, eventSend: () => {}, getPathForFile: () => '' },
});
const { AcpChatStore } = await import('@renderer/features/sessions/acp/acp-chat-store');
let root: Root | null = null;
let host: HTMLElement | null = null;
let store: InstanceType<typeof AcpChatStore> | null = null;

afterEach(() => {
  root?.unmount();
  host?.remove();
  store?.dispose();
  root = null;
  host = null;
  store = null;
});

describe('recoverable startup failure through the real composer', () => {
  it('click and Enter both reach the runtime queue, while an uninstalled engine remains disabled', async () => {
    registerSessionLocaleResources();
    queuePrompt.mockClear();
    store = new AcpChatStore('queue-5939', 'project');
    const current = store;
    const editorApiRef = createRef<PromptEditorRef>();
    const internals = current as unknown as { _bootstrapped: boolean; _startInput: () => unknown };
    internals._startInput = () => ({ sessionId: current.sessionId });
    runInAction(() => {
      internals._bootstrapped = true;
      current.historyLoading = false;
      current.loadError = { kind: 'auth_required', message: 'Sign in required' };
    });
    const Composer = observer(() => (
      <MessageProvider locale="zh-CN" translate={translateSessionMessage}>
        <ChatComposer
          canSubmit={current.affordances.canSubmit}
          editorApiRef={editorApiRef}
          onSubmit={text => {
            editorApiRef.current?.clear();
            current.submitPrompt(text);
          }}
        />
      </MessageProvider>
    ));
    host = document.createElement('div');
    host.className = 'emlight gugu-skin';
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(<Composer />);
    const editor = page.getByTestId('prompt-editor');
    await editor.click();
    await userEvent.keyboard('queued by button');
    await page.getByRole('button', { name: translateSessionMessage('composer.sendMessage') }).click();
    await until('button send reaches the runtime queue', () => queuePrompt.mock.calls.length >= 1);
    expect(queuePrompt.mock.calls.length).toBe(1);
    await editor.click();
    await userEvent.keyboard('queued by Enter{Enter}');
    await until('Enter send reaches the runtime queue', () => queuePrompt.mock.calls.length >= 2);
    expect(queuePrompt.mock.calls.length).toBe(2);
    expect(queuePrompt.mock.calls.map(([input]) => input.prompt.text)).toEqual(['queued by button', 'queued by Enter']);
    runInAction(() => { current.loadError = { kind: 'harness_not_installed', message: 'Install first' }; });
    const sendButton = page.getByRole('button', { name: translateSessionMessage('composer.sendMessage') });
    await until('send button disables for an uninstalled engine', () => (sendButton.query() as HTMLButtonElement | null)?.disabled === true);
    await expect.element(sendButton).toBeDisabled();
  });
});
