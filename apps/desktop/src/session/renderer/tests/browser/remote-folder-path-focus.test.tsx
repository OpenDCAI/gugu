import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { Sheet } from '@/components/ui/Sheet';
import { RemoteFolderPicker } from '@/components/RemoteFolderPicker';
import '@/styles/tokens.css';

const listDirectory = vi.fn(async (_device: string, _request: { path: string; show_hidden?: boolean }, _options?: unknown) => ({ result: { path: '/home/work', home: '/home/work', entries: [] } }));
vi.mock('@/lib/deviceFs', () => ({
  deviceFsListDirectory: (...args: Parameters<typeof listDirectory>) => listDirectory(...args),
  deviceFsMakeDirectory: async () => ({ result: {} }),
}));
vi.mock('react-i18next', async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  listDirectory.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(<Sheet onClose={() => {}} ariaLabel="Choose remote folder" testId="agent-create-project-sheet">
    <RemoteFolderPicker deviceId="remote-device" initialPath="~" onSelect={() => {}} />
  </Sheet>);
  await until('the remote directory loads', () => document.body.textContent?.includes('/home/work') ?? false);
});
afterEach(() => { root.unmount(); host.remove(); });
const input = () => document.querySelector<HTMLInputElement>('[data-testid="remote-folder-path-input"]');
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const completionRequested = (path: string) => until('the draft directory completion is requested', () =>
  listDirectory.mock.calls.some(call => call[1].path === path && call[1].show_hidden === true));

it('retains path focus when the focused breadcrumb button is replaced inside the real Sheet', async () => {
  await userEvent.click(page.getByTestId('remote-folder-path-blank'));
  await frames();
  expect(input()).not.toBeNull();
  expect(document.activeElement).toBe(input());
  await userEvent.keyboard('/srv/project');
  expect(input()!.value).toBe('/srv/project');
  await userEvent.keyboard('{Enter}');
  await until('the path is requested', () => listDirectory.mock.calls.some(call => (call[1] as { path?: string })?.path === '/srv/project'));
});

it('keeps a Chinese composition draft through Enter and navigates only after composition finishes', async () => {
  await userEvent.click(page.getByTestId('remote-folder-path-blank'));
  await frames();
  const field = input();
  expect(field).not.toBeNull();
  field!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  await userEvent.keyboard('/srv/项目');
  // Drain the independent debounced completion before measuring key-triggered requests.
  await completionRequested('/srv');
  const calls = listDirectory.mock.calls.length;
  field!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  await frames();
  expect(input()).toBe(field);
  expect(document.activeElement).toBe(field);
  expect(field!.value).toBe('/srv/项目');
  expect(listDirectory.mock.calls).toHaveLength(calls);
  field!.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '项目' }));
  await userEvent.keyboard('{Enter}');
  await until('the completed Chinese path is requested', () => listDirectory.mock.calls.some(call => (call[1] as { path?: string })?.path === '/srv/项目'));
});

it('keeps the existing keyboard entry, selection and explicit blur contracts', async () => {
  const picker = document.querySelector<HTMLElement>('[aria-label="create.remoteFolders.title"]')!;
  picker.focus();
  await userEvent.keyboard('{Meta>}l{/Meta}');
  await frames();
  expect(document.activeElement).toBe(input());
  expect(input()!.selectionStart).toBe(0);
  expect(input()!.selectionEnd).toBe('/home/work'.length);
  await userEvent.keyboard('{Escape}');
  expect(input()).toBeNull();
  picker.focus();
  await userEvent.keyboard('/');
  await frames();
  expect(input()!.value).toBe('/');
  expect(document.activeElement).toBe(input());
  document.querySelector<HTMLButtonElement>('[aria-label="create.remoteFolders.refresh"]')!.focus();
  await frames();
  expect(input()).toBeNull();
});

it('does not handle IME candidate keys or the composition-ending 229 Enter as picker commands', async () => {
  await userEvent.click(page.getByTestId('remote-folder-path-blank'));
  await frames();
  const field = input()!;
  expect(field).not.toBeNull();
  await userEvent.keyboard('/srv/中文');
  await completionRequested('/srv');
  const calls = listDirectory.mock.calls.length;
  for (const key of ['Escape', 'Tab', 'ArrowDown', 'ArrowUp']) {
    field.dispatchEvent(new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true }));
    await frames();
    expect(input()).toBe(field);
    expect(field.value).toBe('/srv/中文');
  }
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }));
  await frames();
  expect(input()).toBe(field);
  expect(listDirectory.mock.calls).toHaveLength(calls);
  await userEvent.keyboard('{Enter}');
  await until('a normal Enter navigates to the completed path', () => listDirectory.mock.calls.some(call =>
    call[1].path === '/srv/中文' && call[1].show_hidden === false));
});
