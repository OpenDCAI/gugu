import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
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
  await until('the real running highlight and two avatar pulse rings animate', () => host.getAnimations({ subtree: true }).length === 6 && host.querySelector('.rtb-state')?.getAttribute('data-shimmer-visible') === 'true');
  const animations = host.getAnimations({ subtree: true });
  expect(animations.filter((animation) => (animation as CSSAnimation).animationName === 'av-status-pulse')).toHaveLength(2);
  expect(host.querySelector('.rtb-state')!.getAnimations({ subtree: true })).toHaveLength(4);
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
    for (const frame of (animation.effect as KeyframeEffect).getKeyframes()) {
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
  await until('all six CSS animation clocks pause', () => animations.every((animation) => animation.playState === 'paused'));
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
