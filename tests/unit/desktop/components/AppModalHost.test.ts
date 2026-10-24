// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNode, createReactHarness } from '../../../support/testHarness';
import { AppModalHost } from '../../../../apps/desktop/src/components/appModal/AppModalHost';
import { closeAppModal, focusAppModalClose, showAppModal, type AppModalPresentation } from '../../../../apps/desktop/src/components/appModal/appModal';

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => mobile.value }));

let harness: ReturnType<typeof createReactHarness>;
let opener: HTMLButtonElement;
beforeEach(() => {
  mobile.value = false;
  harness = createReactHarness();
  opener = document.createElement('button'); opener.textContent = 'New card'; document.body.append(opener); opener.focus();
});
afterEach(() => { harness.cleanup(); opener.remove(); vi.restoreAllMocks(); });

function presentation(): AppModalPresentation {
  return { id: 'test-modal', appName: 'Teamboard', title: 'New card', size: 'md', url: 'https://app.example/new.html', opener, attach: vi.fn(() => vi.fn()), focus: vi.fn(), dismiss: vi.fn() };
}

describe('the shared App modal host', () => {
  it('renders an attributed dialog with a sandboxed content page over the host', async () => {
    await harness.render(createNode(AppModalHost));
    const modal = presentation();
    await act(async () => showAppModal(modal));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Teamboard');
    expect(dialog?.textContent).toContain('New card');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const frame = dialog?.querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
    expect(frame?.getAttribute('src')).toBe(modal.url);
    expect(modal.attach).toHaveBeenCalledWith(frame);
    await act(async () => closeAppModal(modal.id));
  });

  it('returns a Tab boundary to the close button and dismisses on Escape', async () => {
    await harness.render(createNode(AppModalHost));
    const modal = presentation();
    await act(async () => showAppModal(modal));
    document.querySelector<HTMLIFrameElement>('iframe')!.focus();
    expect(document.activeElement?.tagName).toBe('IFRAME');
    await act(async () => focusAppModalClose(modal.id));
    const button = document.querySelector<HTMLButtonElement>('[data-app-modal-close]')!;
    expect(document.activeElement).toBe(button);
    await act(async () => { button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(modal.dismiss).toHaveBeenCalled();
    await act(async () => closeAppModal(modal.id));
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('uses the existing fullscreen mobile Sheet presentation', async () => {
    mobile.value = true;
    await harness.render(createNode(AppModalHost));
    const modal = presentation();
    await act(async () => showAppModal(modal));
    const sheet = document.querySelector<HTMLElement>('[data-testid="app-modal"]');
    expect(sheet?.dataset.sheetMobile).toBe('true');
    expect(sheet?.dataset.sheetFullscreen).toBe('true');
    expect(sheet?.style.height).toBe('100dvh');
    await act(async () => closeAppModal(modal.id));
  });
});
