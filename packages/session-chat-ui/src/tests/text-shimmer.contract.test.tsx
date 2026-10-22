/** @jsxImportSource solid-js */
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cdp } from 'vitest/browser';
import { until } from '../../../../tests/support/awaitCondition';
import { ShimmerText } from '../components/primitives/ShimmerText';
import { textShimmerClip, textShimmerInk } from '../styles/effects.css';
import { measureSpill } from './contract';

let dispose: (() => void) | undefined;
let surface: HTMLDivElement | undefined;
beforeEach(async () => {
  await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);
});
afterEach(async () => {
  dispose?.();
  surface?.remove();
  window.dispatchEvent(new CustomEvent('__window_seen', { detail: true }));
  await cdp().send('Emulation.setEmulatedMedia', { features: [] });
});

function mount(label = '正在工作 · Running a long command') {
  surface = document.createElement('div');
  surface.style.cssText = 'position:fixed;left:20px;top:20px;width:180px;display:flex;line-height:24px';
  document.body.append(surface);
  const [active, setActive] = createSignal(true);
  const [text, setText] = createSignal(label);
  dispose = render(() => <ShimmerText active={active()}
    style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{text()}</ShimmerText>, surface);
  const host = surface.firstElementChild as HTMLElement;
  return { host, setActive, setText };
}

it('keeps one semantic label, its geometry and live text while animating only transforms', async () => {
  const { host, setText, setActive } = mount();
  await until('the shimmer enters the viewport', () => host.dataset.shimmerVisible === 'true');
  const box = host.getBoundingClientRect().toJSON();
  const animations = host.getAnimations({ subtree: true });
  expect(animations).toHaveLength(4);
  for (const animation of animations) {
    for (const frame of (animation.effect as KeyframeEffect).getKeyframes()) {
      expect(Object.keys(frame).filter((key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key))).toEqual(['transform']);
    }
    animation.pause();
    animation.currentTime = 375;
  }
  expect(host.getBoundingClientRect().toJSON()).toEqual(box);
  expect(measureSpill(surface!)).toBeLessThanOrEqual(0.5);
  // Positive control: losing both clips must expose the offscreen light layer.
  const clip = host.querySelector<HTMLElement>(`.${textShimmerClip}`)!;
  host.style.overflow = 'visible';
  clip.style.overflow = 'visible';
  expect(measureSpill(surface!)).toBeGreaterThan(0.5);
  host.style.overflow = 'hidden';
  clip.style.overflow = '';
  expect(host.textContent).toBe('正在工作 · Running a long command');
  expect(host.querySelector('[aria-hidden="true"]')).not.toBeNull();
  setText('Working for 2 minutes');
  await until('the glyph copy follows live label text', () => host.querySelector<HTMLElement>(`.${textShimmerInk}`)?.dataset.shimmerText === 'Working for 2 minutes');
  setActive(false);
  expect(host.getAnimations({ subtree: true })).toHaveLength(0);
  expect(host.textContent).toBe('Working for 2 minutes');
});

it('pauses outside the viewport, on retained surfaces, and when the host window hides', async () => {
  const { host } = mount();
  await until('the shimmer starts', () => host.dataset.shimmerVisible === 'true');
  window.dispatchEvent(new CustomEvent('__window_seen', { detail: false }));
  expect(host.dataset.shimmerVisible).toBe('true');
  expect(host.getAnimations({ subtree: true }).every((animation) => animation.playState === 'paused')).toBe(true);
  window.dispatchEvent(new CustomEvent('__window_seen', { detail: true }));
  expect(host.dataset.shimmerVisible).toBe('true');
  surface!.style.visibility = 'hidden';
  surface!.inert = true;
  await until('the retained surface pauses', () => host.getAnimations({ subtree: true }).every((animation) => animation.playState === 'paused'));
  surface!.style.visibility = '';
  surface!.inert = false;
  await until('the retained surface resumes', () => host.getAnimations({ subtree: true }).every((animation) => animation.playState === 'running'));
  surface!.style.top = '-200px';
  await until('the offscreen shimmer pauses', () => host.dataset.shimmerVisible === undefined);
  surface!.style.top = '20px';
  await until('the shimmer returns', () => host.dataset.shimmerVisible === 'true');
});

it('keeps reduced-motion labels flat and readable with no running sweep', async () => {
  await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const { host } = mount('正在工作');
  await until('the label mounts', () => host.textContent === '正在工作');
  expect(host.getAnimations({ subtree: true })).toHaveLength(0);
  expect(getComputedStyle(host).webkitTextFillColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(getComputedStyle(host).backgroundImage).toBe('none');
});

// 真机 10-23:时间头扫完第一遍就再也不扫 —— 行的数据在停顿那 1 秒里换了一个对象(转录一更新就重建),
// `active` 仍为真,可效果因此重跑、清掉了待重扫的计时器,扫完的动画再没有人倒回去。
it('keeps replaying when the row data is rebuilt during the hold while it stays active', async () => {
  surface = document.createElement('div');
  surface.style.cssText = 'position:fixed;left:20px;top:20px;width:180px;display:flex;line-height:24px';
  document.body.append(surface);
  const [item, setItem] = createSignal({ status: 'running' });
  dispose = render(() => <ShimmerText active={item().status === 'running'}>Worked for 19s</ShimmerText>, surface);
  const host = surface.firstElementChild as HTMLElement;
  await until('the shimmer animations are ready', () => ({
    visible: host.dataset.shimmerVisible,
    animations: host.getAnimations({ subtree: true }).length,
  }), (state) => state.visible === 'true' && state.animations === 4);
  const animations = host.getAnimations({ subtree: true });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    for (const animation of animations) animation.finish();
    await until('the finished sweep schedules its replay', () => vi.getTimerCount() === 1);
    setItem({ status: 'running' });
    expect(vi.getTimerCount(), 'a rebuilt row that is still running keeps its pending replay').toBe(1);
    vi.advanceTimersByTime(1000);
    expect(animations.every((animation) => animation.currentTime === 0 && animation.playState === 'running')).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('finishes each sweep, holds without running animations, and rewinds without overriding CSS pauses', async () => {
  const { host, setActive } = mount();
  await until('the shimmer animations are ready after motion emulation resets', () => ({
    visible: host.dataset.shimmerVisible,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    animations: host.getAnimations({ subtree: true }).map((animation) => animation.playState),
  }), (state) => state.visible === 'true' && !state.reducedMotion && state.animations.length === 4);
  const animations = host.getAnimations({ subtree: true });
  expect(animations).toHaveLength(4);
  for (const animation of animations) {
    expect(animation.effect!.getTiming()).toMatchObject({ duration: 1000, iterations: 1, fill: 'forwards' });
  }
  const renderedFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    for (const animation of animations) animation.finish();
    await until('the first finished sweep schedules its replay', () => vi.getTimerCount() === 1);
    expect(animations.every((animation) => animation.playState === 'finished')).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    window.dispatchEvent(new CustomEvent('__window_seen', { detail: false }));
    expect(host.getAnimations({ subtree: true }).every((animation) => animation.playState === 'paused')).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(animations.every((animation) => animation.currentTime === 0 && animation.playState === 'paused')).toBe(true);
    window.dispatchEvent(new CustomEvent('__window_seen', { detail: true }));
    await renderedFrame();
    expect(host.getAnimations({ subtree: true }).every((animation) => animation.playState === 'running')).toBe(true);

    for (const animation of animations) animation.finish();
    await until('the next finished sweep schedules its replay', () => vi.getTimerCount() === 1);
    expect(vi.getTimerCount()).toBe(1);
    setActive(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(host.getAnimations({ subtree: true })).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});
