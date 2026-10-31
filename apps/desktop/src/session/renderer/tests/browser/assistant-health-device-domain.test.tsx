import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import zh from '@/i18n/locales/zh-CN/assistant';
import type { AssistantContext } from '@renderer/features/assistant/assistant-context';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), readMemory: vi.fn(async () => ({ notes: [], index: null })) }));
vi.mock('@renderer/lib/ipc', () => {
  const blocked = () => { mocks.rpc(); throw new Error('No device RPC belongs on this health page'); };
  const rpc = new Proxy({}, { get: () => new Proxy({}, { get: () => blocked }) });
  return { rpc, rpcOn: () => rpc, invokeOnMachine: vi.fn(), events: { on: () => () => {} }, onMachineEvent: () => () => {} };
});
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: {} }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: {} }));
vi.mock('@renderer/features/assistant/assistant-home-sessions', () => ({ homeSessions: vi.fn(), homeTarget: vi.fn() }));
vi.mock('@renderer/features/assistant/assistant-machine', () => ({
  readMemoryNotes: mocks.readMemory, listDirectory: vi.fn(), openAssistantMachine: vi.fn(), readText: vi.fn(),
}));
vi.mock('react-i18next', async original => ({ ...await original<object>(), useTranslation: () => ({ t: (key: string) => key.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown>)?.[k], zh) ?? key }) }));

const { AssistantHealthPage } = await import('@renderer/features/assistant/assistant-health');
await import('@renderer/index.css');
let root: Root | undefined;
let node: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  node?.remove();
  vi.clearAllMocks();
});

it('shows an honest desktop empty state without consulting phone capabilities or drawing zero metrics', async () => {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  const askInChat = vi.fn();
  const context = { assistant: { display_name: '咕咕' }, readiness: 'waiting', machine: undefined, askInChat } as unknown as AssistantContext;
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(<QueryClientProvider client={query}><AssistantHealthPage context={context} /></QueryClientProvider>));
  await expect.element(page.getByTestId('assistant-health-empty')).toHaveTextContent('暂无健康数据');
  expect(node.querySelector('[data-testid="assistant-health-today"]')).toBeNull();
  expect(node.querySelector('[data-testid^="assistant-health-signal-"]')).toBeNull();
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.readMemory).not.toHaveBeenCalled();
  await page.getByTestId('assistant-health-analyze').click();
  expect(askInChat).toHaveBeenCalledOnce();
  expect(askInChat.mock.calls[0][0]).toContain('数据所在设备的执行者');
  expect(node.querySelector('input[type="file"]')?.getAttribute('accept')).toBe('application/pdf,image/*');
  expect(mocks.rpc).not.toHaveBeenCalled();
  query.clear();
});
