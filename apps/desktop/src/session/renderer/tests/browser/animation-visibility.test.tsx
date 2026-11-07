import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Avatar } from '@/components/Avatar';
import { RunningTokenBar } from '@/components/RunningTokenBar';
import { ANIMATION_WINDOW_SEEN_EVENT, isAnimationWindowVisible } from '@gugu/session-shared/animation-visibility';
import { mirrorDocument } from '@renderer/lib/aux-document';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@gugu/session-shared/animation-visibility.css';
import animationVisibilityCSS from '@gugu/session-shared/animation-visibility.css?inline';

const roots: Root[] = [];
const cleanup: Array<() => void> = [];
const avatar = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"%3E%3Crect width="20" height="20" fill="gray"/%3E%3C/svg%3E';

afterEach(() => {
  roots.splice(0).forEach((root) => root.unmount());
  cleanup.splice(0).reverse().forEach((stop) => stop());
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
  delete document.documentElement.dataset.animationTest;
});

async function mount(doc = document) {
  isAnimationWindowVisible(doc);
  const host = doc.createElement('div');
  doc.body.append(host);
  cleanup.push(() => host.remove());
  const root = createRoot(host);
  roots.push(root);
  root.render(<>
    <RunningTokenBar previewChatId={null} tokens={[{
      id: 'animation-agent', name: 'Agent', avatarSeed: 'animation-agent', avatarUrl: avatar,
      stateKey: 'running', toolCount: 1, lastActiveAt: null,
    }]} />
    <Avatar name="Running agent" seed="animation-agent" avatarUrl={avatar} isAgent agentStatus="working" harnessBadge={false} />
  </>);
  await until('the real running highlight and two avatar pulse rings animate', () => host.getAnimations({ subtree: true }).length === 4 && host.querySelector<HTMLElement>('.rtb-state')?.style.getPropertyValue('--gugu-animation-viewport-paused') === '');
  const animations = host.getAnimations({ subtree: true });
  expect(animations.filter((animation) => (animation as CSSAnimation).animationName === 'av-status-pulse')).toHaveLength(2);
  expect(host.querySelector('.rtb-state')!.getAnimations({ subtree: true })).toHaveLength(2);
  expect(animations.every((animation) => animation.playState === 'running')).toBe(true);
  return { host, animations };
}

it('keeps one semantic running label and stationary glyphs throughout the composited sweep', async () => {
  const { host } = await mount();
  const label = host.querySelector<HTMLElement>('.rtb-state')!;
  const text = label.textContent;
  const glyphs = [...label.querySelectorAll<HTMLElement>('[data-shimmer-text]')];
  expect(glyphs).toHaveLength(2);
  expect(label.querySelector('[aria-hidden="true"]')!.textContent).toBe('');
  expect(glyphs.every((glyph) => glyph.dataset.shimmerText === text)).toBe(true);
  const box = label.getBoundingClientRect();
  const animations = label.getAnimations({ subtree: true });
  for (const animation of animations) {
    expect(animation.effect!.getTiming()).toMatchObject({ duration: 2000, iterations: Infinity });
    const frames = (animation.effect as KeyframeEffect).getKeyframes();
    // The transcript's rhythm as one loop: 20 steps in the first second, then still until the next cycle.
    expect(frames.map((frame) => frame.computedOffset)).toEqual([0, 0.5, 1]);
    expect(frames[0]!.easing).toBe('steps(20)');
    expect(frames[1]!.transform).toBe(frames[2]!.transform);
    for (const frame of frames) {
      expect(Object.keys(frame).filter((key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key))).toEqual(['transform']);
    }
    animation.pause();
  }
  for (const time of [0, 500, 1000, 1999]) {
    animations.forEach((animation) => { animation.currentTime = time; });
    for (const glyph of glyphs) {
      expect(Math.abs(glyph.getBoundingClientRect().left - box.left)).toBeLessThan(0.1);
      expect(Math.abs(glyph.getBoundingClientRect().width - box.width)).toBeLessThan(0.1);
    }
    expect(label.textContent).toBe(text);
    expect(label.getBoundingClientRect().toJSON()).toEqual(box.toJSON());
  }
});

it('pauses and resumes the running highlight and avatar pulses on the shared native signal', async () => {
  const { host, animations } = await mount();
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }));
  await until('all four CSS animation clocks pause', () => animations.every((animation) => animation.playState === 'paused'));
  expect(document.hidden).toBe(false);
  expect(getComputedStyle(host.querySelector('.rtb-state')!).animationPlayState).toBe('paused');
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
  await until('the same CSS animation clocks resume', () => animations.every((animation) => animation.playState === 'running'));
  expect(host.getAnimations({ subtree: true })).toEqual(animations);
  host.inert = true;
  await until('a retained inert surface pauses the same clocks', () => animations.every((animation) => animation.playState === 'paused'));
  host.inert = false;
  await until('showing the retained surface resumes motion', () => animations.every((animation) => animation.playState === 'running'));
});

it('pauses avatar pulses scrolled out of view and resumes the same clocks when they return', async () => {
  const { host, animations } = await mount();
  const pulses = animations.filter((animation) => (animation as CSSAnimation).animationName === 'av-status-pulse');
  // 14 steps while the ring is visible, then still: the second ring's 0.7 s delay lands on the same 70 ms grid.
  const frames = (pulses[0]!.effect as KeyframeEffect).getKeyframes();
  expect(frames.map((frame) => frame.computedOffset)).toEqual([0, 0.7, 1]);
  expect(frames[0]!.easing).toBe('steps(14)');
  expect(frames[1]!.transform).toBe(frames[2]!.transform);
  host.style.cssText = 'position:fixed;left:0;top:-2000px';
  await until('the off-screen pulses pause', () => pulses.every((animation) => animation.playState === 'paused'));
  // Knock the clocks far off the document's; coming back has to bring them home, whatever the machine's speed.
  for (const animation of pulses) animation.currentTime = Number(animation.timeline!.currentTime) - 60_000;
  host.style.cssText = '';
  await until('the pulses resume on screen', () => pulses.every((animation) => animation.playState === 'running'));
  expect(host.getAnimations({ subtree: true })).toEqual(animations);
  // Back on the shared beat, and still paused by the shared stylesheet afterwards.
  for (const animation of pulses) expect(Math.abs(Number(animation.currentTime) - Number(animation.timeline!.currentTime))).toBeLessThan(30_000);
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }));
  await until('the window pause still reaches the pulses', () => pulses.every((animation) => animation.playState === 'paused'));
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
  await until('they resume', () => pulses.every((animation) => animation.playState === 'running'));
});

it('leaves the style pass alone when watched motion goes away', async () => {
  await mount();
  // getAnimations({ subtree: true }) resolves the whole document's pending style on the spot.
  const getAnimations = vi.spyOn(Element.prototype, 'getAnimations');
  roots.splice(0).forEach((root) => root.unmount());
  await new Promise(requestAnimationFrame);
  expect(getAnimations).not.toHaveBeenCalled();
  getAnimations.mockRestore();
});

it('keeps a visible portal animated while the opener hides and stops it when its own window hides', async () => {
  isAnimationWindowVisible();
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }));
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:700px;height:300px';
  document.body.append(frame);
  cleanup.push(() => frame.remove());
  const doc = frame.contentDocument!;
  cleanup.push(mirrorDocument(document, doc));
  const { animations } = await mount(doc);
  document.documentElement.dataset.animationTest = 'mirrored';
  await until('the opener theme mirror has run', () => doc.documentElement.dataset.animationTest === 'mirrored');
  expect(isAnimationWindowVisible()).toBe(false);
  expect(animations.every((animation) => animation.playState === 'running')).toBe(true);
  doc.defaultView!.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }));
  await until('the portal own native signal pauses its animations', () => animations.every((animation) => animation.playState === 'paused'));
  doc.defaultView!.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
  await until('the portal own restore resumes its animations', () => animations.every((animation) => animation.playState === 'running'));
});

it('pauses and resumes an infinite animation inside a CSS-isolated shadow root', async () => {
  isAnimationWindowVisible();
  const host = document.createElement('div');
  document.body.append(host);
  cleanup.push(() => host.remove());
  const shadow = host.attachShadow({ mode: 'open' });
  // An isolated style scope loads the actual shipped visibility stylesheet,
  // alongside its own animation styles; document selectors cannot enter it.
  const sheet = document.createElement('style');
  sheet.textContent = `${animationVisibilityCSS}\n@keyframes shadow-spin { to { transform: rotate(360deg); } }`;
  const glyph = document.createElement('span');
  glyph.textContent = 'Working';
  glyph.style.animation = 'shadow-spin 1s linear infinite';
  shadow.append(sheet, glyph);
  await until('the shadow animation runs', () => getComputedStyle(glyph).animationPlayState === 'running' && glyph.getAnimations().length === 1);
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }));
  await until('the shadow animation pauses through the inherited window state', () => getComputedStyle(glyph).animationPlayState === 'paused');
  expect(glyph.getAnimations()[0].playState).toBe('paused');
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
  await until('the shadow animation resumes', () => getComputedStyle(glyph).animationPlayState === 'running');
  expect(glyph.getAnimations()[0].playState).toBe('running');
});
