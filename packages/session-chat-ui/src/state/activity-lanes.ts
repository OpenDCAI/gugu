import type { RenderUnit } from '../core/units';

export type ActivityLane = { index: number; end: number; id: string };

/** Structural indices only: a committed prefix is cached independently of streamed row data. */
export function activityLanes(units: readonly RenderUnit[], offset = 0): ActivityLane[] {
  const lanes: ActivityLane[] = [];
  for (let index = 0; index < units.length; index++) {
    const unit = units[index];
    if (unit.kind === 'agent-activity') lanes.push({ index: index + offset, end: index + offset + 1, id: unit.id });
    else if (unit.activityFold && unit.activityFold === lanes.at(-1)?.id) lanes.at(-1)!.end = index + offset + 1;
  }
  return lanes;
}

export function joinedActivityLanes(committed: readonly ActivityLane[], active: readonly RenderUnit[], base: number): ActivityLane[] {
  const result = committed.map(lane => ({ ...lane }));
  const last = result.at(-1);
  if (last?.end === base && active[0]?.activityFold === last.id) {
    for (let i = 0; i < active.length && active[i].activityFold === last.id; i++) last.end = base + i + 1;
  }
  return [...result, ...activityLanes(active, base)];
}
