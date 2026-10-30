import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cdp } from 'vitest/browser';
import { ANIMATION_WINDOW_SEEN_EVENT } from '@gugu/session-shared/animation-visibility';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@renderer/index.css';
import '@gugu/session-shared/animation-visibility.css';

// Root contract: the running glyph turns on the compositor (a stepped transform of its glyph strip); no timer steps it,
// and it holds still whenever it cannot be seen — including the tab's own glyph while the × covers it.
// Viewport visibility is driven explicitly: the runner may host this file in an iframe that is not on screen, where the
// real IntersectionObserver rightly reports "not intersecting" and the glyph rightly stays paused.
// The page's own visibility is pinned too (a background runner tab may report hidden); the window-seen event is the
// switch under test.
vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
const observers: Array<{ callback: IntersectionObserverCallback; targets: Element[] }> = [];
vi.stubGlobal('IntersectionObserver', class {
  private readonly entry: { callback: IntersectionObserverCallback; targets: Element[] };
  constructor(callback: IntersectionObserverCallback) { this.entry = { callback, targets: [] }; observers.push(this.entry); }
  observe(target: Element) { this.entry.targets.push(target); this.entry.callback([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver); }
  unobserve(target: Element) { this.entry.targets = this.entry.targets.filter((t) => t !== target); }
  disconnect() { this.entry.targets = []; }
});
const { CLISpinner } = await import('@renderer/lib/components/cliSpinner');
const { TabCloseButton } = await import('@renderer/features/tabs/tab-bar/tab-close-button');
const roots: Root[] = [];
const hosts: HTMLElement[] = [];
type Cdp = { send: (method: string, params: object) => Promise<unknown> };
/** The real media feature, set on the browser as the OS setting would be; a CI runner's own default must not decide. */
async function reducedMotion(value: 'reduce' | 'no-preference' | null) {
  await (cdp() as unknown as Cdp).send('Emulation.setEmulatedMedia', { features: value ? [{ name: 'prefers-reduced-motion', value }] : [] });
  if (value) await until(`the page reads prefers-reduced-motion: ${value}`, () => matchMedia(`(prefers-reduced-motion: ${value})`).matches);
}
beforeEach(() => reducedMotion('no-preference'));
afterEach(async () => {
  await reducedMotion(null);
  roots.splice(0).forEach((root) => root.unmount());
  hosts.splice(0).forEach((host) => host.remove());
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
});
function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(node);
  roots.push(root); hosts.push(host);
  return host;
}
const strips = (host: HTMLElement) => [...host.querySelectorAll('.cli-spinner__strip')].flatMap((strip) => strip.getAnimations());

it('turns with one infinite stepped animation and no timer, and pauses with its window', async () => {
  const timers = vi.spyOn(window, 'setInterval');
  const host = mount(<CLISpinner variant="2" />);
  await until('the strip turns', () => strips(host).length === 1 && strips(host)[0]!.playState === 'running');
  const timing = strips(host)[0]!.effect!.getComputedTiming();
  expect(timing.iterations).toBe(Infinity);
  expect(timing.duration).toBe(24 * 80);
  expect(timers).not.toHaveBeenCalled();
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }));
  await until('it pauses with the window', () => strips(host)[0]!.playState === 'paused');
});

it('the active tab, whose × covers the glyph, holds it still; an inactive tab keeps it turning', async () => {
  const tab = (active: boolean) => (
    <div className="group" data-tab-active={active ? '' : undefined}>
      <TabCloseButton onClose={() => {}} ariaLabel="close" statusIndicator={<CLISpinner />} />
    </div>
  );
  const inactive = mount(tab(false));
  const active = mount(tab(true));
  await until('both strips exist', () => strips(inactive).length === 1 && strips(active).length === 1);
  await until('the hidden glyph is paused', () => strips(active)[0]!.playState === 'paused');
  expect(strips(inactive)[0]!.playState).toBe('running');
});

it('with reduced motion the glyph strip holds its first frame and nothing runs', async () => {
  await reducedMotion('reduce');
  const host = mount(<CLISpinner />);
  await until('the strip is mounted', () => host.querySelector('.cli-spinner__strip') !== null);
  expect(strips(host)).toHaveLength(0);
  expect(getComputedStyle(host.querySelector('.cli-spinner__strip')!).transform).toBe('none');
});
