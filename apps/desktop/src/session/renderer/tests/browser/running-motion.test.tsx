import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CLISpinner } from '@renderer/lib/components/cliSpinner';
import { TabCloseButton } from '@renderer/features/tabs/tab-bar/tab-close-button';
import { ANIMATION_WINDOW_SEEN_EVENT } from '@gugu/session-shared/animation-visibility';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@renderer/index.css';
import '@gugu/session-shared/animation-visibility.css';

// Root contract: the running glyph turns on the compositor (a stepped transform of its glyph strip); no timer steps it,
// and it holds still whenever it cannot be seen — including the tab's own glyph while the × covers it.
const roots: Root[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
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
