/** @jsxImportSource solid-js */
/**
 * Chromium contract for #5332 — a row's tween entry follows the unit currently
 * mounted in that row, and is never captured at mount.
 *
 * A row component lives per visible index (`<For each={visible()}>`), so any
 * structural change ABOVE the viewport — loadOlder prepend, #4874 turn fold /
 * unfold, a transcript rebuild — hands a live row instance a different unit
 * while a freshly mounted row takes over the index that unit used to occupy.
 *
 * When the tween key was captured at mount, those two live rows claimed one
 * entry and overwrote each other's height forever: Solid re-entered
 * runUpdates/completeUpdates synchronously round after round with no cap, and
 * the renderer died with "Maximum call stack size exceeded" — the whole task
 * page fell into the React error boundary (observed three times in the packaged
 * 0.2.37 build).
 *
 * Four things must hold across that shift, and each of them was broken at some
 * point while fixing this:
 *   1. every live row claims its OWN unit's key;
 *   2. a row leaving a key does not delete the entry another live row took over;
 *   3. the shift itself snaps — it is not a collapse toggle, so nothing animates;
 *   4. the row re-subscribes to the entry it now owns (a swap replaces the
 *      entry, so a row left holding the disposed one freezes its clip).
 */
import { CachesContext } from '@session-chat/components/contexts/CachesContext';
import { CommandsContext } from '@session-chat/components/contexts/CommandsContext';
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext';
import { createChatCaches } from '@session-chat/core/caches';
import { DEFAULT_CONFIG, buildChatTheme } from '@session-chat/core/config';
import type { MeasureCtx } from '@session-chat/core/define';
import type { ChatLayout } from '@session-chat/core/layout/preset';
import { Virtualizer } from '@session-chat/core/virtualizer';
import { unit, unitReservedHeight } from '@session-chat/core/units';
import type { RenderUnit } from '@session-chat/core/units';
import type { ChatMessage } from '@session-chat/model';
import { createViewState } from '@session-chat/state/view-state';
import { For, batch, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import { messageUnitDef, normalizeMessage } from '@session-chat/components/rows/message/message.def';
import { createTweenRegistry } from './tween-registry';
import type { TweenRegistry } from './tween-registry';
import { UnitRow } from './UnitRow';

const WIDTH = 640;
const LAYOUT: ChatLayout = { preset: 'single', userGutter: 0 };

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

function messageUnit(id: string, text: string): RenderUnit {
  const raw: ChatMessage = { kind: 'message', id, seq: 0, role: 'assistant', text };
  const item = normalizeMessage(raw);
  return unit('message', item, item, { key: 'self' }) as RenderUnit;
}

type RegistryEvent = { op: 'set'; key: string };

describe('UnitRow tween key (#5332)', () => {
  it('a prepend that shifts every row onto a different unit leaves each row on its own live entry', async () => {
    const theme = buildChatTheme(DEFAULT_CONFIG, LAYOUT);
    const caches = createChatCaches();
    const viewState = createViewState();
    const virt = new Virtualizer();
    // Motion ON: `set()` must decide snap-vs-animate from the flag the row
    // passes, so a reduced-motion registry would hide criterion 3 entirely.
    const real = createTweenRegistry(virt, () => {}, { reducedMotion: () => false });

    const events: RegistryEvent[] = [];
    const reg: TweenRegistry = {
      set(key, getIndex, target, shouldAnim, owner) {
        events.push({ op: 'set', key });
        return real.set(key, getIndex, target, shouldAnim, owner);
      },
      unregister: (key, owner) => real.unregister(key, owner),
      advance: (now) => real.advance(now),
      heightOf: (key) => real.heightOf(key),
    };

    // Rows are mounted in reverse index order on purpose: Solid runs effects in
    // creation order, so this is the interleaving where a row walking away from
    // a key reaches `unregister` AFTER a neighbour has taken that key over. The
    // natural order hides both hazards below.
    // Three units with genuinely different heights — a shared entry can only be
    // detected when the two claimants disagree about the target.
    const u0 = messageUnit('m0', 'zero');
    const u1 = messageUnit('m1', 'one\n\none more paragraph so this row is taller');
    const u2 = messageUnit('m2', ['two', '', 'a', '', 'much', '', 'taller', '', 'row'].join('\n'));

    const measureCtx: MeasureCtx = {
      theme,
      width: WIDTH,
      isCollapsed: () => false,
      expanded: () => false,
      caches,
      expandedId: null,
    };
    const reservedOf = (u: RenderUnit): number =>
      unitReservedHeight(
        u,
        messageUnitDef.measure(u.data as ChatMessage, measureCtx, messageUnitDef.vars!)
      );

    // u1 is expanded (inverted semantics: `isCollapsed(id) === true` means
    // expanded). This is what makes criterion 3 falsifiable: after the shift,
    // index 0 goes from u1 (expanded) to u0 (not), so a row that compares the
    // two units' expand signatures reads a toggle that never happened.
    viewState.setCollapsed(u1.itemId, true);

    // Before: the viewport holds [u1, u2] at indices 0 and 1.
    const [units, setUnits] = createSignal<RenderUnit[]>([u1, u2]);
    const [indices, setIndices] = createSignal<number[]>([1, 0]);

    virt.setCount(2, () => 0);

    const host = document.createElement('div');
    host.style.width = `${WIDTH}px`;
    document.body.appendChild(host);

    const dispose = render(
      () => (
        <ThemeContext.Provider value={() => theme}>
          <CachesContext.Provider value={caches}>
            <CommandsContext.Provider value={() => ({})}>
              <For each={indices()}>
                {(index) => (
                  <UnitRow
                    unit={units().at(index)!}
                    index={index}
                    rowWidth={WIDTH}
                    theme={theme}
                    viewState={viewState}
                    virt={virt}
                    onHeightChanged={() => {}}
                    tweenRegistry={reg}
                    caches={caches}
                    expandedId={null}
                    finalReplyId={null}
                  />
                )}
              </For>
            </CommandsContext.Provider>
          </CachesContext.Provider>
        </ThemeContext.Provider>
      ),
      host
    );

    const clipOfItem = (itemId: string): HTMLElement => {
      const row = host.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`);
      const clip = row?.firstElementChild as HTMLElement | null;
      if (!clip) throw new Error(`no row is showing item ${itemId}`);
      return clip;
    };

    try {
      await nextPaint();
      events.length = 0;

      // loadOlder / fold / rebuild: u0 arrives above, so index 0 is handed u0,
      // index 1 is handed u1 (it used to hold u2), and index 2 mounts fresh with
      // u2 — the key index 1 is walking away from. Both writes land in ONE flush,
      // which is what production does and what interleaves the two rows.
      virt.setCount(3, () => 0);
      expect(() => {
        batch(() => {
          setUnits([u0, u1, u2]);
          setIndices([1, 0, 2]);
        });
      }).not.toThrow();

      await nextPaint();

      // 1 — every live row claims its own unit's key, nobody shares.
      const claimed = events.map((e) => e.key);
      expect(new Set(claimed)).toEqual(new Set([u0.id, u1.id, u2.id]));

      // 2 — the shift is not a collapse toggle: nothing may be mid-tween.
      expect(real.advance(performance.now())).toBe(false);

      // Heights land on each row's OWN unit.
      expect(virt.size(0)).toBeCloseTo(reservedOf(u0), 5);
      expect(virt.size(1)).toBeCloseTo(reservedOf(u1), 5);
      expect(virt.size(2)).toBeCloseTo(reservedOf(u2), 5);
      expect(new Set([reservedOf(u0), reservedOf(u1), reservedOf(u2)]).size).toBe(3);

      // 3 + 4 — every row is still wired to a LIVE entry it owns. Arm a tween on
      // each key from outside and watch the clip engage. This fails both ways
      // that a shift can strand a row: if a row walking away deleted the entry a
      // neighbour had taken over, or if a row kept the handle of the entry its
      // own swap replaced, that row never sees `animating` flip.
      for (const u of [u0, u1, u2]) {
        expect(`${u.id}:${getComputedStyle(clipOfItem(u.itemId)).overflow}`).toBe(
          `${u.id}:visible`
        );
      }
      // One key at a time: arming all three at once would clip every row no
      // matter which entry each row is actually holding.
      real.set(u1.id, () => 0, reservedOf(u1) + 400, true);
      await nextPaint();
      expect(`m1:${getComputedStyle(clipOfItem(u1.itemId)).overflow}`).toBe('m1:hidden');
      expect(`m0:${getComputedStyle(clipOfItem(u0.itemId)).overflow}`).toBe('m0:visible');
      expect(`m2:${getComputedStyle(clipOfItem(u2.itemId)).overflow}`).toBe('m2:visible');
    } finally {
      dispose();
      host.remove();
      caches.clearAll();
    }
  });
});
