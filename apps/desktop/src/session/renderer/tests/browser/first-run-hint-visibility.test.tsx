import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { useFirstRunHintTargets, type HintTarget } from '@/components/firstRun/firstRunHintTargets';
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface';
import { until } from '../../../../../../../tests/support/awaitCondition';

// The hint locator asks the rendering step (IntersectionObserver) whether an entry is on screen. In real Chromium:
// an entry inside a retained hidden surface (content-visibility:hidden), under display:none or scrolled out is not a
// target; showing the surface makes it one. And a list update elsewhere on the page costs no forced style recalc.
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach((stop) => stop()));

function mountProbe(seen: { targets: readonly HintTarget[] }) {
  const host = document.createElement('div');
  document.body.append(host);
  const root: Root = createRoot(host);
  function Probe() { seen.targets = useFirstRunHintTargets('desktop', true); return null; }
  act(() => root.render(<Probe />));
  cleanup.push(() => { act(() => root.unmount()); host.remove(); });
}

function addEntry() {
  const surface = document.createElement('section');
  surface.style.position = 'relative';
  const entry = document.createElement('div');
  entry.dataset.firstRunHint = 'collaboration';
  entry.dataset.firstRunDevice = 'desktop';
  entry.textContent = 'Projects';
  entry.style.cssText = 'width: 120px; height: 24px';
  const space = document.createElement('div');
  space.dataset.firstRunHintSpace = 'collaboration';
  surface.append(entry, space);
  document.body.append(surface);
  cleanup.push(() => surface.remove());
  return { surface, entry, space };
}

it('locates an entry only while it is rendered on screen', async () => {
  const seen = { targets: [] as readonly HintTarget[] };
  const { surface, entry, space } = addEntry();
  Object.assign(surface.style, RETAINED_SURFACE_HIDDEN_STYLE);
  mountProbe(seen);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(seen.targets).toEqual([]);

  surface.style.contentVisibility = 'visible';
  surface.style.transform = 'none';
  await until('the shown entry is located', () => seen.targets.length === 1);
  expect(seen.targets[0]).toMatchObject({ id: 'collaboration', anchor: entry, space });

  surface.style.display = 'none';
  await until('a display:none entry is dropped', () => seen.targets.length === 0);
  surface.style.display = '';
  await until('it is located again', () => seen.targets.length === 1);
  surface.hidden = true;
  await until('a [hidden] surface drops it', () => seen.targets.length === 0);
});

it('an entry added after mount is found, and a removed one is dropped', async () => {
  const seen = { targets: [] as readonly HintTarget[] };
  mountProbe(seen);
  const { surface } = addEntry();
  await until('the added entry is located', () => seen.targets.length === 1);
  surface.remove();
  await until('the removed entry is dropped', () => seen.targets.length === 0);
});
