import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createReactHarness, deferred } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { BrowserPageSurface } from '@renderer/features/browser/browser-page-surface';

const api = vi.hoisted(() => ({
  mountPage: vi.fn(),
  layoutPage: vi.fn(),
  snapshotPage: vi.fn(),
  releasePage: vi.fn(),
}));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { browser: api },
}));
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn() }) }));
vi.mock('@renderer/features/browser/agent-browser-state', () => ({ agentBrowserState: () => 'idle' }));

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6zUkAAAAASUVORK5CYII=';
let harness: ReturnType<typeof createReactHarness>;

beforeEach(async () => {
  await page.viewport(900, 700);
  vi.clearAllMocks();
  api.mountPage.mockResolvedValue({ success: true, reused: false, ready: true, state: { url: 'https://example.com', title: 'page', canGoBack: false, canGoForward: false } });
  api.layoutPage.mockResolvedValue(true);
  api.releasePage.mockResolvedValue(true);
  api.snapshotPage.mockResolvedValue({ dataUrl: image });
  harness = createReactHarness();
});
afterEach(() => harness.cleanup());

async function mountCoveredPage() {
  await harness.render(<div style={{ position: 'fixed', inset: 0 }}>
    <style>{'[data-browser-page] { width: 100%; height: 100%; }'}</style>
    <BrowserPageSurface browserId="snapshot-regression" partition="persist:test" initialUrl="https://example.com" visible onHandle={() => {}} />
    <div role="dialog" style={{ position: 'fixed', inset: 0, zIndex: 10 }}>Blocking dialog</div>
  </div>);
  return harness.container.querySelector<HTMLElement>('[data-browser-page]')!;
}

it('still yields to an overlay when snapshot capture fails', async () => {
  const surface = (covered: boolean) => <div style={{ position: 'fixed', inset: 0 }}>
    <style>{'[data-browser-page] { width: 100%; height: 100%; }'}</style>
    <BrowserPageSurface browserId="snapshot-regression" partition="persist:test" initialUrl="https://example.com" visible onHandle={() => {}} />
    {covered && <div role="dialog" style={{ position: 'fixed', inset: 0, zIndex: 10 }}>Blocking dialog</div>}
  </div>;
  await harness.render(surface(false));
  await until('the page is shown', () => api.layoutPage.mock.calls.some(([args]) => args.mode === 'shown'));
  api.snapshotPage.mockRejectedValue(new Error('capture failed'));
  await harness.render(surface(true));
  await until('the overlay is allowed above the page', () => api.layoutPage.mock.calls.some(([args]) => args.mode === 'occluded'));
});

it('sizes a page first mounted behind a dialog before requesting its snapshot', async () => {
  api.snapshotPage.mockImplementation(async () => {
    expect(api.layoutPage).toHaveBeenCalledWith(expect.objectContaining({ mode: 'occluded', rect: expect.objectContaining({ width: 900, height: 700 }) }));
    return { dataUrl: image };
  });
  const surface = await mountCoveredPage();
  await until('the initial occluded page has an image', () => surface.style.backgroundImage !== '');
  expect(api.snapshotPage).toHaveBeenCalledTimes(1);
});

it('shows a late snapshot even after the overlay wait limit has elapsed', async () => {
  const capture = deferred<{ dataUrl: string }>();
  api.snapshotPage.mockReturnValue(capture.promise);
  const original = globalThis.setTimeout.bind(globalThis);
  let finishWait: (() => void) | undefined;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay, ...args) => {
    if (delay === 250 && typeof handler === 'function') {
      finishWait = () => handler(...args);
      return original(() => {}, 5000);
    }
    return original(handler, delay, ...args);
  });
  const surface = await mountCoveredPage();
  await until('snapshot capture started', () => api.snapshotPage.mock.calls.length > 0);
  expect(finishWait).toBeDefined();
  finishWait!();
  await Promise.resolve();
  await Promise.resolve();
  expect(surface.style.backgroundImage).toBe('');
  capture.resolve({ dataUrl: image });
  await until('the late image is displayed', () => surface.style.backgroundImage !== '');
});
