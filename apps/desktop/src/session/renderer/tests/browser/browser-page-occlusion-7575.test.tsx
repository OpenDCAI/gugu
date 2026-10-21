import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { page } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { BuildTagBadge } from '@/components/BuildTagBadge';
import { isBrowserPageOccluded } from '@renderer/features/browser/browser-page-occlusion';
import '@/styles/tokens.css';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let harness: ReturnType<typeof createReactHarness>;
let popupFrame: HTMLIFrameElement | null = null;

beforeEach(async () => {
  await page.viewport(1280, 900);
  vi.stubGlobal('__GUGU_BUILD_TAG__', 'beta-7575');
  vi.stubGlobal('__GUGU_TEST_NOTES__', 'Browser page visibility regression');
  harness = createReactHarness();
});

afterEach(() => {
  harness.cleanup();
  popupFrame?.remove();
  popupFrame = null;
  vi.unstubAllGlobals();
});

it('keeps the browser visible beside the collapsed build badge', async () => {
  vi.stubGlobal('electronAPI', {});
  popupFrame = document.createElement('iframe');
  popupFrame.style.cssText = 'position:fixed;left:-10000px;top:0;width:360px;height:400px';
  document.body.append(popupFrame);
  const popup = { document: popupFrame.contentDocument!, closed: false, close: vi.fn() };
  const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  await harness.render(<>
    <div data-browser-page="regression" style={{ position: 'fixed', left: 800, top: 100, right: 8, bottom: 8 }} />
    <StrictMode><BuildTagBadge /></StrictMode>
  </>);
  const placeholder = harness.container.querySelector<HTMLElement>('[data-browser-page]')!;
  const rect = placeholder.getBoundingClientRect();
  const badge = popup.document.querySelector('details')!;
  expect(badge).not.toBeNull();
  expect(badge.open).toBe(false);
  // 原生窗按文档的 preferred size 跟随内容:收起不能被上一轮较高的视口撑住。
  const collapsedHeight = badge.getBoundingClientRect().height;
  await until('collapsed document fits the badge', () => popup.document.documentElement.getBoundingClientRect().height === Math.ceil(collapsedHeight));
  badge.open = true;
  await until('expanded document fits the notes', () => popup.document.documentElement.getBoundingClientRect().height > Math.ceil(collapsedHeight));
  badge.open = false;
  await until('collapsed document shrinks again', () => popup.document.documentElement.getBoundingClientRect().height === Math.ceil(collapsedHeight));
  expect(harness.container.querySelector('details')).toBeNull();
  expect(isBrowserPageOccluded(placeholder, rect)).toBe(false);
  await Promise.resolve();
  expect(open).toHaveBeenCalledTimes(1);
  expect(popup.close).not.toHaveBeenCalled();
});

it('reports a real dialog covering the page', async () => {
  await harness.render(<>
    <div data-browser-page="regression" style={{ position: 'fixed', left: 800, top: 100, right: 8, bottom: 8 }} />
    <div role="dialog" style={{ position: 'fixed', inset: 0, zIndex: 10 }}>A real blocking dialog</div>
  </>);
  const placeholder = harness.container.querySelector<HTMLElement>('[data-browser-page]')!;
  expect(isBrowserPageOccluded(placeholder, placeholder.getBoundingClientRect())).toBe(true);
});

it('does not mistake the rounded pane clipping its own page corner for an overlay', async () => {
  await harness.render(<div style={{ position: 'fixed', inset: 8, borderRadius: 12, clipPath: 'inset(0 round 12px)', overflow: 'hidden', background: '#fff' }}>
    <div data-browser-page="rounded-page" style={{ position: 'absolute', inset: 0 }} />
  </div>);
  const placeholder = harness.container.querySelector<HTMLElement>('[data-browser-page]')!;
  const rect = placeholder.getBoundingClientRect();
  const corner = document.elementFromPoint(rect.right - 3, rect.bottom - 3)!;
  expect(corner, JSON.stringify({ rect: rect.toJSON(), viewport: [innerWidth, innerHeight], parent: placeholder.parentElement?.getAttribute('style') })).not.toBe(placeholder);
  expect(corner.contains(placeholder)).toBe(true);
  expect(isBrowserPageOccluded(placeholder, rect)).toBe(false);
});
