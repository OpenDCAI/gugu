import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cdp, userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { SessionRowShell } from '@renderer/features/sidebar/sidebar-session-row';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import '@/styles/tokens.css';
import '@renderer/index.css';

const LONG_TITLE = '打开百度搜索并注册 AI 网站，然后核对新用户注册和邮件通知的完整流程';
let root: Root;
let host: HTMLDivElement;
let park: HTMLDivElement;
const onOpen = vi.fn();
const onDragStart = vi.fn((event: React.DragEvent) => event.dataTransfer.setData('text/plain', 'title-reveal'));
const media = (reducedMotion: 'reduce' | 'no-preference') =>
  cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reducedMotion }] });

beforeEach(async () => {
  host = document.createElement('div');
  host.className = 'gugu-skin emlight';
  host.style.width = '260px';
  document.body.append(host);
  root = createRoot(host);
  park = document.createElement('div');
  park.style.cssText = 'position:fixed;right:0;bottom:0;width:80px;height:80px';
  document.body.append(park);
  await userEvent.hover(park);
  await media('no-preference');
  onOpen.mockClear();
  onDragStart.mockClear();
});

afterEach(async () => {
  root.unmount(); host.remove(); park.remove(); vi.restoreAllMocks();
  await media('no-preference');
});

async function mount(title = LONG_TITLE) {
  root.render(
    <SessionLocalizationProvider>
      <SessionRowShell
        sessionId="title-reveal" rowVariant="tree" depth={0} hasChildren={false} expanded={false}
        needsAttention={false} title={title} harness={null} status="idle" lastInteractedAt={null}
        doneUnread={false} isActive={false} isCursor={false} isPendingArchive={false}
        quickActions={{ isPinned: false, onSetPinned: () => {}, archiveLabel: 'Archive', onArchive: () => {} }}
        onOpen={onOpen}
        rowProps={{ draggable: true, onDragStart }}
      />
    </SessionLocalizationProvider>,
  );
  await until('session row rendered', () => host.querySelector('[data-session-id]')?.textContent?.includes(title) ?? false);
  return host.querySelector<HTMLElement>('[data-session-id]')!;
}

const viewport = () => host.querySelector<HTMLElement>('[data-session-id] button span[data-overflow]')!;
const track = () => viewport().firstElementChild as HTMLElement;
const x = () => new DOMMatrix(getComputedStyle(track()).transform).m41;
function runningAnimation() {
  const animation = track().getAnimations()[0];
  expect(animation, 'the actual hovered title must have a browser animation').toBeDefined();
  return animation;
}

it('reveals only an overflowing title, stops with the full end readable, and resets on leave', async () => {
  const row = await mount();
  await until('long title measured', () => viewport() != null);
  const before = viewport().getBoundingClientRect();
  const actions = host.querySelector<HTMLElement>('[data-row-hover-actions]')!;
  const actionsBefore = actions.getBoundingClientRect();
  expect(before.width).toBeGreaterThan(0);
  expect(track().getBoundingClientRect().width).toBeGreaterThan(before.width);
  expect(track().getAnimations()).toHaveLength(0);
  expect(row.querySelector('button')?.getAttribute('aria-label')).toBe(translateSessionMessage('sidebar.openConversation', { title: LONG_TITLE }));

  await userEvent.hover(row);
  const animation = runningAnimation();
  animation.pause();
  animation.currentTime = 200;
  expect(x()).toBe(0); // The opening pause lets the start be read first.
  const timing = animation.effect!.getComputedTiming();
  animation.currentTime = Number(timing.endTime) / 2;
  expect(x()).toBeLessThan(0);
  animation.finish();
  viewport().getAnimations().forEach((a) => a.finish());
  const end = track().getBoundingClientRect();
  expect(end.right).toBeCloseTo(before.right, 0);
  expect(end.right).toBeLessThanOrEqual(actionsBefore.left);
  expect(viewport().getBoundingClientRect().width).toBe(before.width);
  expect(actions.getBoundingClientRect().left).toBe(actionsBefore.left);

  await userEvent.hover(park);
  expect(track().getAnimations()).toHaveLength(0);
  expect(x()).toBe(0);
});

it('does not animate a short title and preserves row activation', async () => {
  const row = await mount('短标题');
  await userEvent.hover(row);
  expect(host.querySelector('[data-overflow]')).toBeNull();
  expect(row.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().fill === 'forwards')).toHaveLength(0);
  await userEvent.click(row.querySelector('button')!);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it('remeasures the lane when resized and removes motion when the title fits', async () => {
  const row = await mount();
  await until('long title measured', () => viewport() != null);
  await userEvent.hover(row);
  runningAnimation().finish();
  host.style.width = '1200px';
  await until('wide lane fits', () => host.querySelector('[data-overflow]') === null);
  host.style.width = '260px';
  await until('narrow lane measured', () => viewport() != null);
  expect(track().getBoundingClientRect().width).toBeGreaterThan(viewport().clientWidth);
});

it('reveals the title for keyboard focus and still allows dragging from the title', async () => {
  const row = await mount();
  await until('long title measured', () => viewport() != null);
  await userEvent.keyboard('{Tab}');
  await until('keyboard focuses row', () => document.activeElement === row);
  runningAnimation().finish();
  await userEvent.keyboard('{Tab}');
  expect(document.activeElement).toBe(row.querySelector('button'));
  expect(track().getAnimations()).toHaveLength(1);
  await userEvent.dragAndDrop(row.querySelector('button')!, park);
  expect(onDragStart).toHaveBeenCalledTimes(1);
});

it('resets a replaced title and exposes its complete text without motion for reduced motion users', async () => {
  let row = await mount();
  await until('long title measured', () => viewport() != null);
  await userEvent.hover(row);
  runningAnimation().finish();
  await media('reduce');
  row = await mount(`${LONG_TITLE}（重新命名）`);
  await userEvent.hover(row);
  expect(viewport().title).toBe(`${LONG_TITLE}（重新命名）`);
  // The reveal is two CSS animations (revealTitle on the track, revealEnd on the viewport); none may run.
  // ❌ Not "no Animation objects": under reduced motion index.css turns every style change into a 0.01ms
  // transition (here `scrollbar-color` on hover) that only ends on the next frame — a race the assertion
  // lost 9/10 on a slow frame clock (mac1 over SSH) and won on CI's 60fps.
  expect([viewport(), track()].flatMap((el) => el.getAnimations()).filter((a) => a instanceof CSSAnimation)).toHaveLength(0);
  expect(x()).toBe(0);
});
