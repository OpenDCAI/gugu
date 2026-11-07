import type { RenderUnit } from '@session-chat/core/units';
import type { Virtualizer } from '@session-chat/core/virtualizer';
import type { ActivityLane } from '@session-chat/state/activity-lanes';
import type { UnitsView } from '@session-chat/state/flatten';
import type { TweenRegistry } from './tween-registry';

/** Offscreen rows participate in the same 200ms height tween without mounting their message DOM. */
export function createActivityGeometry(virt: Virtualizer, registry: TweenRegistry, changed: (index: number, delta: number) => void) {
  let model: object | undefined;
  let currentUnits: UnitsView | undefined;
  let currentLanes = new Map<string, ActivityLane>();
  let disposed = false;
  let gates = new Map<string, boolean>();
  const heights = new Map<string, number>();
  const owned = new Set<string>();
  const owner = {};
  const clear = () => { for (const id of owned) registry.unregister(id, owner); owned.clear(); heights.clear(); gates.clear(); };
  // Re-resolve only after a structural shift. Ordinary streaming keeps the O(1) index.
  const locate = (unit: RenderUnit, initial: number) => {
    let index = initial;
    return () => {
      if (currentUnits?.at(index)?.id === unit.id) return index;
      const lane = currentLanes.get(unit.activityFold!);
      index = -1;
      if (lane) for (let i = lane.index + 1; i < lane.end; i++) {
        if (currentUnits?.at(i)?.id === unit.id) { index = i; break; }
      }
      return index;
    };
  };
  return {
    /** A virtualized row hands its in-flight tween back instead of abandoning a partial height. */
    release(unit: RenderUnit, target: number): boolean {
      if (disposed || !unit.activityFold || !currentLanes.has(unit.activityFold)) return false;
      if (target > 0) heights.set(unit.id, target);
      registry.set(unit.id, locate(unit, -1), target, true, owner);
      owned.add(unit.id);
      return true;
    },
    sync(current: object, units: UnitsView, lanes: readonly ActivityLane[], expanded: (id: string) => boolean,
      estimate: (unit: RenderUnit) => number) {
      if (current !== model) { clear(); model = current; }
      currentUnits = units;
      currentLanes = new Map(lanes.map(lane => [lane.id, lane]));
      const next = new Map(lanes.map(lane => [lane.id, expanded(lane.id)]));
      for (const lane of lanes) {
        const open = next.get(lane.id)!;
        if (gates.get(lane.id) === open) continue;
        const animate = gates.has(lane.id);
        for (let index = lane.index + 1; index < lane.end; index++) {
          const unit = units.at(index)!;
          const before = virt.size(index);
          if (!open && before > 0) heights.set(unit.id, before);
          const target = open ? heights.get(unit.id) ?? estimate(unit) : 0;
          if (animate) {
            const getIndex = locate(unit, index);
            if (registry.heightOf(unit.id) === undefined) registry.set(unit.id, getIndex, before, false, owner);
            registry.set(unit.id, getIndex, target, true);
            owned.add(unit.id);
          } else {
            const delta = virt.setSize(index, target);
            if (delta) changed(index, delta);
          }
        }
      }
      gates = next;
    },
    dispose() { disposed = true; clear(); currentUnits = undefined; currentLanes.clear(); },
  };
}
