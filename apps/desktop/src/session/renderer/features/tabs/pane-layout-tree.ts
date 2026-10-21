import type { PaneLayoutSnapshotNode } from '@shared/view-state';

/**
 * 一个会话里的格子怎么摆:一棵树,叶子是一格(一条页签条 + 它的内容),内节点是一刀 —— 左右并排或上下叠着
 * (spec session-page「一屏几块」:会话里面把页签拖到格子边上 = 再分格,每格一条自己的页签条)。
 *
 * 纯数据、纯函数:每次改动返回一棵新树(PaneLayoutStore 把它当一个整体换掉),所以这里的规矩能脱离 MobX 单测。
 * `horizontal` = 左右并排(一行),`vertical` = 上下叠着(一列)—— 与 react-resizable-panels 的 orientation 同名同义。
 */
export type PaneSplitOrientation = 'horizontal' | 'vertical';

export type PaneLayoutNode =
  | { type: 'pane'; paneId: string }
  | { type: 'split'; id: string; orientation: PaneSplitOrientation; children: PaneLayoutNode[]; sizes: number[] };

export type PaneEdge = 'left' | 'right' | 'top' | 'bottom';

export const edgeOrientation = (edge: PaneEdge): PaneSplitOrientation =>
  edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical';

const before = (edge: PaneEdge) => edge === 'left' || edge === 'top';

let nextSplit = 1;
const splitId = () => `split-${nextSplit++}`;

export function paneLeaf(paneId: string): PaneLayoutNode {
  return { type: 'pane', paneId };
}

/**
 * 一棵格子树最少要多宽(`width`)/ 多高(`height`):一格至少 `unit`;顺着这一向排开的几格加起来(外加中间的分界线),
 * 横着那一向叠着的取最宽的那一格。
 */
export function minExtent(node: PaneLayoutNode, axis: 'width' | 'height', unit: number, gap = 1): number {
  if (node.type === 'pane') return unit;
  const inner = node.children.map((child) => minExtent(child, axis, unit, gap));
  const along = (node.orientation === 'horizontal') === (axis === 'width');
  return along ? inner.reduce((sum, value) => sum + value, 0) + gap * (inner.length - 1) : Math.max(...inner);
}

/** Every pane, top-left to bottom-right (depth first): the order the panes are listed and walked in. */
export function paneOrder(node: PaneLayoutNode): string[] {
  return node.type === 'pane' ? [node.paneId] : node.children.flatMap(paneOrder);
}

/** Even sizes that add up to 100 (the first takes the remainder). */
export function evenSizes(count: number): number[] {
  if (count <= 0) return [];
  const size = Math.floor(100 / count);
  const sizes = new Array<number>(count).fill(size);
  sizes[0] += 100 - sizes.reduce((a, b) => a + b, 0);
  return sizes;
}

/**
 * A new pane beside `targetPaneId`, on that edge. Next to a sibling in a cut of the same direction it joins that cut,
 * taking half of the target's share; otherwise the target becomes a two-pane cut of its own (half and half).
 * A target that is not in the tree leaves it as it was.
 */
export function insertBeside(root: PaneLayoutNode, targetPaneId: string, newPaneId: string, edge: PaneEdge): PaneLayoutNode {
  const orientation = edgeOrientation(edge);
  const fresh = paneLeaf(newPaneId);
  const visit = (node: PaneLayoutNode): PaneLayoutNode => {
    if (node.type === 'pane') {
      if (node.paneId !== targetPaneId) return node;
      return {
        type: 'split',
        id: splitId(),
        orientation,
        children: before(edge) ? [fresh, node] : [node, fresh],
        sizes: [50, 50],
      };
    }
    const at = node.children.findIndex((child) => child.type === 'pane' && child.paneId === targetPaneId);
    if (at >= 0 && node.orientation === orientation) {
      const half = node.sizes[at] / 2;
      const children = [...node.children];
      const sizes = [...node.sizes];
      const insertAt = before(edge) ? at : at + 1;
      children.splice(insertAt, 0, fresh);
      sizes.splice(at, 1, half, half);
      return { ...node, children, sizes };
    }
    return { ...node, children: node.children.map(visit) };
  };
  return visit(root);
}

/**
 * The tree without that pane: its share goes to its neighbour (the next one, or the previous at the end), and a cut left
 * with one child is replaced by that child. The last pane cannot be removed (the caller keeps one).
 */
export function removePane(root: PaneLayoutNode, paneId: string): PaneLayoutNode {
  return removeWithShares(root, paneId) ?? root;
}

/** The removal itself, crediting a removed child's share to its next sibling (or the previous one when it was last). */
function removeWithShares(node: PaneLayoutNode, paneId: string): PaneLayoutNode | null {
  if (node.type === 'pane') return node.paneId === paneId ? null : node;
  const kept: { child: PaneLayoutNode; size: number }[] = [];
  let carry = 0;
  node.children.forEach((child, index) => {
    const next = removeWithShares(child, paneId);
    const size = node.sizes[index] ?? 0;
    if (next === null) {
      if (index < node.children.length - 1) carry += size;
      else if (kept.length > 0) kept[kept.length - 1].size += size;
      return;
    }
    kept.push({ child: next, size: size + carry });
    carry = 0;
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].child;
  return { ...node, children: kept.map((entry) => entry.child), sizes: normalize(kept.map((entry) => entry.size)) };
}

/** Sizes that add up to 100, in the same proportions (all zero → even). */
export function normalize(sizes: readonly number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + Math.max(0, size), 0);
  if (total <= 0) return evenSizes(sizes.length);
  const result = sizes.map((size) => Math.floor((Math.max(0, size) / total) * 100));
  result[0] += 100 - result.reduce((sum, value) => sum + value, 0);
  return result;
}

/** The cut with that id, its sizes replaced (a list of another length is ignored). */
export function setSplitSizes(root: PaneLayoutNode, id: string, sizes: readonly number[]): PaneLayoutNode {
  if (root.type === 'pane') return root;
  if (root.id === id) return sizes.length === root.children.length ? { ...root, sizes: normalize(sizes) } : root;
  return { ...root, children: root.children.map((child) => setSplitSizes(child, id, sizes)) };
}

/** The cut that directly holds that pane, back to even shares (a new pane that would not fit in half of its neighbour). */
export function equalizeAround(root: PaneLayoutNode, paneId: string): PaneLayoutNode {
  if (root.type === 'pane') return root;
  if (root.children.some((child) => child.type === 'pane' && child.paneId === paneId)) return { ...root, sizes: evenSizes(root.children.length) };
  return { ...root, children: root.children.map((child) => equalizeAround(child, paneId)) };
}

/** Double-click on a divider: that cut back to even shares. */
export function equalizeSplit(root: PaneLayoutNode, id: string): PaneLayoutNode {
  if (root.type === 'pane') return root;
  if (root.id === id) return { ...root, sizes: evenSizes(root.children.length) };
  return { ...root, children: root.children.map((child) => equalizeSplit(child, id)) };
}

/**
 * A tree that names exactly these panes, from what was saved: saved panes that no longer exist drop out, panes the tree
 * does not name are put to the right of everything. With nothing saved (layouts from before the tree), the panes stand
 * side by side in their order with the saved sizes — what the session page showed then.
 */
export function layoutFor(paneIds: readonly string[], saved: PaneLayoutSnapshotNode | undefined, legacySizes?: readonly number[]): PaneLayoutNode {
  const ids = new Set(paneIds);
  const fromSaved = saved ? restoreNode(saved, ids) : null;
  const named = new Set(fromSaved ? paneOrder(fromSaved) : []);
  const missing = paneIds.filter((id) => !named.has(id));
  if (fromSaved && missing.length === 0) return fromSaved;
  if (fromSaved) {
    const children = [fromSaved, ...missing.map(paneLeaf)];
    return { type: 'split', id: splitId(), orientation: 'horizontal', children, sizes: evenSizes(children.length) };
  }
  if (paneIds.length === 1) return paneLeaf(paneIds[0]);
  const sizes = legacySizes && legacySizes.length === paneIds.length ? normalize(legacySizes) : evenSizes(paneIds.length);
  return { type: 'split', id: splitId(), orientation: 'horizontal', children: paneIds.map(paneLeaf), sizes };
}

function restoreNode(node: PaneLayoutSnapshotNode, ids: ReadonlySet<string>): PaneLayoutNode | null {
  if ('pane' in node) return ids.has(node.pane) ? paneLeaf(node.pane) : null;
  const kept: { child: PaneLayoutNode; size: number }[] = [];
  node.children.forEach((child, index) => {
    const restored = restoreNode(child, ids);
    if (restored) kept.push({ child: restored, size: node.sizes[index] ?? 0 });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].child;
  const orientation: PaneSplitOrientation = node.split === 'vertical' ? 'vertical' : 'horizontal';
  return { type: 'split', id: splitId(), orientation, children: kept.map((entry) => entry.child), sizes: normalize(kept.map((entry) => entry.size)) };
}

/** What is saved: the shape and the shares, no ids (they are made again on restore). */
export function snapshotOf(node: PaneLayoutNode): PaneLayoutSnapshotNode {
  if (node.type === 'pane') return { pane: node.paneId };
  return { split: node.orientation, children: node.children.map(snapshotOf), sizes: [...node.sizes] };
}

/** The panes sharing an edge with this one on that side, nearest first — the next pane to the right / below, … */
export function neighbourInOrder(root: PaneLayoutNode, paneId: string, side: 'before' | 'after'): string | undefined {
  const order = paneOrder(root);
  const at = order.indexOf(paneId);
  if (at < 0) return undefined;
  return order[side === 'after' ? at + 1 : at - 1];
}

/** The pane in that corner: down the first child (top / left) or the last (right) of each cut. */
export function cornerPane(node: PaneLayoutNode, corner: 'top-left' | 'top-right'): string {
  if (node.type === 'pane') return node.paneId;
  const pick =
    corner === 'top-left'
      ? node.children[0]
      : node.orientation === 'horizontal'
        ? node.children[node.children.length - 1]
        : node.children[0];
  return cornerPane(pick, corner);
}
