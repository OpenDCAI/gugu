import { useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { Sheet } from '@/components/ui/Sheet';
import { RemoteFolderPicker } from '@/components/RemoteFolderPicker';
import { useFloatingCardKeys } from '../../app/floating-card-keys';

vi.mock('@/lib/deviceFs', () => ({
  deviceFsListDirectory: async () => ({ result: { path: '/home/work', home: '/home/work', entries: [{ name: 'project', kind: 'directory' }] } }),
  deviceFsMakeDirectory: async () => ({ result: {} }),
}));
vi.mock('react-i18next', async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  root.unmount();
  host.remove();
});

function ProjectDock({ withCard }: { withCard: boolean }) {
  const [cardShown, setCardShown] = useState(withCard);
  const dockRef = useRef<HTMLDivElement>(null);
  useFloatingCardKeys(cardShown, () => setCardShown(false), dockRef);
  return (
    <>
      <div data-testid="floating-card-state">{cardShown ? 'shown' : 'hidden'}</div>
      <div ref={dockRef} data-region="composer">
        <div contentEditable data-testid="prompt-editor" suppressContentEditableWarning />
      </div>
      <Sheet onClose={() => {}} ariaLabel="Choose remote folder">
        <RemoteFolderPicker deviceId="remote-device" initialPath="~" onSelect={() => {}} onCancel={() => {}} />
      </Sheet>
    </>
  );
}

async function newFolder(withCard: boolean) {
  root.render(<ProjectDock withCard={withCard} />);
  await until('the remote directory loads', () => document.body.textContent?.includes('project') ?? false);
  const button = document.querySelector<HTMLButtonElement>('[data-testid="remote-folder-new"]')!;
  await userEvent.click(button);
  await until('the new-folder input receives focus', () => document.activeElement?.getAttribute('data-testid') === 'remote-folder-new-name');
  return document.querySelector<HTMLInputElement>('[data-testid="remote-folder-new-name"]')!;
}

it.each([true, false])('keeps typed folder names in the real picker with card shown=%s', async (withCard) => {
  const input = await newFolder(withCard);
  await userEvent.keyboard('abc');
  expect(input.value).toBe('abc');
  expect(document.activeElement).toBe(input);
  expect(host.querySelector('[data-testid="prompt-editor"]')!.textContent).toBe('');
  expect(host.querySelector('[data-testid="floating-card-state"]')!.textContent).toBe(withCard ? 'shown' : 'hidden');
});

it('lets the picker cancel its name input with Escape without dismissing the floating card', async () => {
  await newFolder(true);
  await userEvent.keyboard('{Escape}');
  await until('the picker or floating card handles Escape', () => !document.querySelector('[data-testid="remote-folder-new-name"]') || host.querySelector('[data-testid="floating-card-state"]')!.textContent === 'hidden');
  expect(document.querySelector('[data-testid="remote-folder-new-name"]')).toBeNull();
  expect(host.querySelector('[data-testid="floating-card-state"]')!.textContent).toBe('shown');
  expect(document.querySelector('[aria-label="Choose remote folder"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="prompt-editor"]')!.textContent).toBe('');
});
