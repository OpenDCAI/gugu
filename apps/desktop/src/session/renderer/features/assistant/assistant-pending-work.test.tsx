// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { AssistantContext } from './assistant-context';
import { AssistantPendingWork } from './assistant-pending-work';

const state = vi.hoisted(() => ({ fail: false, items: [{ id: 'work', kind: 'executor', source_link: 'gugu-chat://request/message',
  recipients: ['session:child'], state: 'waiting', created_at: '2026-10-24T00:00:00Z', receipt_ids: [] }] as unknown[] }));
const change = vi.hoisted(() => vi.fn());
const call = vi.hoisted(() => vi.fn(async (name: string) => {
  if (state.fail) throw new Error('read failed');
  if (name === 'assistant_work_clear') state.items = [];
  return { structuredContent: { result: { version: 1, items: state.items } } };
}));
const client = vi.hoisted(() => vi.fn(() => ({ callProgram: call, onProgramNotification: () => () => undefined })));
vi.mock('@/store/devicesCache', () => ({ cachedDevicesAccount: () => 'owner' }));
vi.mock('@/components/assistant/assistant-app-client', () => ({ assistantAppClient: client, reportAssistantAppChange: change }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, data?: { count: number }) => data ? `${key}:${data.count}` : key }) }));
vi.mock('@renderer/lib/ui/markdown-renderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock('./assistant-ui', () => ({ AssistantSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  AssistantEmpty: ({ children }: { children: React.ReactNode }) => <p>{children}</p> }));
let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
afterEach(async () => { if (root) await act(async () => { root.unmount(); }); container?.remove(); queryClient?.clear(); vi.clearAllMocks(); state.fail = false; });
const context = { machine: { rpc: { app: {} } }, homeDeviceId: 'home', assistant: { id: 'assistant' } } as unknown as AssistantContext;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
async function open() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root.render(<QueryClientProvider client={queryClient}><AssistantPendingWork context={context} /></QueryClientProvider>); });
  await settle();
}
it('reads from the assistant home and clearing forgets entries through the App without a task cancellation', async () => {
  await open();
  expect(container.querySelector('summary')?.textContent).toBe('memory.pending.count:1');
  await act(async () => { container.querySelector('summary')!.click(); });
  expect(container.textContent).toContain('memory.pending.executor');
  expect(client).toHaveBeenCalledWith(context.machine, 'owner', true);
  const clear = [...container.querySelectorAll('button')].find(button => button.textContent === 'memory.pending.clear');
  await act(async () => { clear!.click(); }); await settle();
  expect(container.querySelector('summary')?.textContent).toBe('memory.pending.count:0');
  expect(change).toHaveBeenCalledWith(context.machine, 'assistant', { resource: 'pending-work', operation: 'removed', id: 'pending-work' });
  expect(call.mock.calls.every(([name]) => ['assistant_work_list', 'assistant_work_clear'].includes(name))).toBe(true);
});
it('does not display a fabricated zero while the recovery state is unreadable', async () => {
  state.fail = true;
  await open();
  expect(container.querySelector('summary')?.textContent).toBe('memory.pending.retry');
  expect(container.textContent).not.toContain('memory.pending.count:0');
});
