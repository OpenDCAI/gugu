/** @jsxImportSource solid-js */
import { observeAnimationViewport } from '@gugu/session-shared/animation-visibility';
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, splitProps, type JSX } from 'solid-js';
import { textShimmer, textShimmerBaseSweep, textShimmerClip, textShimmerInk, textShimmerLightInk, textShimmerSweep } from '@session-chat/styles/effects.css';

/** Stationary text with a composited light sweep. The decorative copy has no DOM text or semantics. */
export function ShimmerText(props: JSX.HTMLAttributes<HTMLSpanElement> & { active: boolean }) {
  const [local, rest] = splitProps(props, ['active', 'children', 'class', 'classList']);
  // One boolean, ❌ the caller's getter: a row's data object is rebuilt on every transcript update while
  // it stays active. Tracking the getter re-ran the effect below on each rebuild, its cleanup cleared the
  // pending replay, and a sweep that finished in that hold never ran again (10-23: the turn header swept once).
  const active = createMemo(() => !!local.active);
  const [text, setText] = createSignal('');
  const [visible, setVisible] = createSignal(false);
  let host!: HTMLSpanElement;
  let clip!: HTMLSpanElement;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;

  // @@@no-prop-reads-in-handlers - this runs from a DOM event, where Solid has no owner. Reading
  // `local.active` here would run the caller's prop getter (`status === 'running' && …` compiles to a
  // getter that builds a memo per read) and leak an ownerless memo that outlives the row and throws
  // once its unit is gone. No check is needed: the sweep only exists under <Show when={local.active}>.
  const sweepEnded = (event: AnimationEvent) => {
    if (event.target !== event.currentTarget) return;
    // A finished animation stops compositor ticks during the hold. Rewinding
    // its clock preserves CSS control of window/surface/viewport pauses;
    // calling play() here would override animation-play-state instead.
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      for (const animation of clip.getAnimations({ subtree: true })) animation.currentTime = 0;
    }, 1000);
  };

  onMount(() => {
    createEffect(() => {
      if (!active()) return;
      const syncText = () => setText(host.textContent ?? '');
      syncText();
      // Labels can contain live text nodes (elapsed time, thinking status). Only
      // content changes update the static glyph texture; animation never does.
      const content = new MutationObserver(syncText);
      content.observe(host, { subtree: true, childList: true, characterData: true });
      const stop = observeAnimationViewport(host, setVisible);
      onCleanup(() => { content.disconnect(); stop(); clearTimeout(restartTimer); });
    });
  });

  return (
    <span {...rest} ref={host} class={local.class}
      classList={{ ...local.classList, [textShimmer]: active() }}
      data-shimmer-visible={active() && visible() ? 'true' : undefined}>
      {local.children}
      <Show when={active()}>
        <span ref={clip} aria-hidden="true" class={textShimmerClip}>
          <span class={textShimmerBaseSweep} onAnimationEnd={sweepEnded}>
            <span class={textShimmerInk} data-shimmer-text={text()} />
          </span>
          <span class={textShimmerSweep}>
            <span class={`${textShimmerInk} ${textShimmerLightInk}`} data-shimmer-text={text()} />
          </span>
        </span>
      </Show>
    </span>
  );
}
