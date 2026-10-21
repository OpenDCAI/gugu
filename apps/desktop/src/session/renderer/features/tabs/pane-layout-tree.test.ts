import { describe, expect, it } from 'vitest';
import {
  equalizeSplit,
  insertBeside,
  layoutFor,
  minExtent,
  neighbourInOrder,
  paneLeaf,
  paneOrder,
  removePane,
  setSplitSizes,
  snapshotOf,
  type PaneLayoutNode,
} from './pane-layout-tree';

// #7052 会话里的格子:拖页签到格子边上 = 在那边分出一格,上下左右都行,可以一层套一层。
const shape = (node: PaneLayoutNode): unknown =>
  node.type === 'pane' ? node.paneId : { [node.orientation === 'horizontal' ? 'row' : 'col']: node.children.map(shape), sizes: node.sizes };

describe('一棵格子最少要多大 (#7052 窄格子)', () => {
  it('左右排开的加起来(外加分界线),上下叠着的取最宽;高度反过来', () => {
    const row = insertBeside(paneLeaf('a'), 'a', 'b', 'right');
    expect(minExtent(paneLeaf('a'), 'width', 220)).toBe(220);
    expect(minExtent(row, 'width', 220)).toBe(441);
    expect(minExtent(row, 'height', 160)).toBe(160);
    const nested = insertBeside(row, 'b', 'c', 'bottom');
    expect(minExtent(nested, 'width', 220)).toBe(441);
    expect(minExtent(nested, 'height', 160)).toBe(321);
  });
});

describe('pane layout tree (#7052)', () => {
  it('分在一格的边上:左右 = 并排,上下 = 叠着;新格在拖到的那一边', () => {
    expect(shape(insertBeside(paneLeaf('a'), 'a', 'b', 'right'))).toEqual({ row: ['a', 'b'], sizes: [50, 50] });
    expect(shape(insertBeside(paneLeaf('a'), 'a', 'b', 'left'))).toEqual({ row: ['b', 'a'], sizes: [50, 50] });
    expect(shape(insertBeside(paneLeaf('a'), 'a', 'b', 'bottom'))).toEqual({ col: ['a', 'b'], sizes: [50, 50] });
    expect(shape(insertBeside(paneLeaf('a'), 'a', 'b', 'top'))).toEqual({ col: ['b', 'a'], sizes: [50, 50] });
  });

  it('同一个方向的接着并进那一刀,分走那一格的一半;换个方向就在那一格里套一刀', () => {
    const row = insertBeside(paneLeaf('a'), 'a', 'b', 'right');
    expect(shape(insertBeside(row, 'b', 'c', 'right'))).toEqual({ row: ['a', 'b', 'c'], sizes: [50, 25, 25] });
    expect(shape(insertBeside(row, 'b', 'c', 'bottom'))).toEqual({ row: ['a', { col: ['b', 'c'], sizes: [50, 50] }], sizes: [50, 50] });
    expect(paneOrder(insertBeside(row, 'b', 'c', 'bottom'))).toEqual(['a', 'b', 'c']);
  });

  it('关掉一格:它的份额给旁边那格(后一格,在最后就给前一格);一刀只剩一格就退回那一格', () => {
    const three: PaneLayoutNode = {
      type: 'split', id: 's', orientation: 'horizontal', children: [paneLeaf('a'), paneLeaf('b'), paneLeaf('c')], sizes: [50, 30, 20],
    };
    expect(shape(removePane(three, 'b'))).toEqual({ row: ['a', 'c'], sizes: [50, 50] });
    expect(shape(removePane(three, 'c'))).toEqual({ row: ['a', 'b'], sizes: [50, 50] });
    const nested = insertBeside(insertBeside(paneLeaf('a'), 'a', 'b', 'right'), 'b', 'c', 'bottom');
    expect(shape(removePane(nested, 'c'))).toEqual({ row: ['a', 'b'], sizes: [50, 50] });
    expect(shape(removePane(removePane(nested, 'c'), 'b'))).toEqual('a');
    // The last pane stays.
    expect(shape(removePane(paneLeaf('a'), 'a'))).toEqual('a');
  });

  it('拖分界改份额、双击分界等分', () => {
    const row = insertBeside(paneLeaf('a'), 'a', 'b', 'right');
    const id = row.type === 'split' ? row.id : '';
    const moved = setSplitSizes(row, id, [70, 30]);
    expect(shape(moved)).toEqual({ row: ['a', 'b'], sizes: [70, 30] });
    expect(shape(equalizeSplit(moved, id))).toEqual({ row: ['a', 'b'], sizes: [50, 50] });
    // A list of another length is not this cut's.
    expect(shape(setSplitSizes(row, id, [10, 20, 70]))).toEqual({ row: ['a', 'b'], sizes: [50, 50] });
  });

  it('存档读回来:形状照存的;存档里没有的格接在最右,已经不在的格去掉;没有形状的老存档按老样子左右并排', () => {
    const nested = insertBeside(insertBeside(paneLeaf('a'), 'a', 'b', 'right'), 'b', 'c', 'bottom');
    const saved = snapshotOf(nested);
    expect(shape(layoutFor(['a', 'b', 'c'], saved))).toEqual(shape(nested));
    expect(shape(layoutFor(['a', 'c'], saved))).toEqual({ row: ['a', 'c'], sizes: [50, 50] });
    expect(shape(layoutFor(['a', 'b', 'c', 'd'], saved))).toEqual({ row: [shape(nested), 'd'], sizes: [50, 50] });
    expect(shape(layoutFor(['a', 'b'], undefined, [62, 38]))).toEqual({ row: ['a', 'b'], sizes: [62, 38] });
    expect(shape(layoutFor(['a'], undefined, [100]))).toEqual('a');
  });

  it('按走的顺序找旁边那一格', () => {
    const nested = insertBeside(insertBeside(paneLeaf('a'), 'a', 'b', 'right'), 'b', 'c', 'bottom');
    expect(neighbourInOrder(nested, 'a', 'after')).toBe('b');
    expect(neighbourInOrder(nested, 'c', 'before')).toBe('b');
    expect(neighbourInOrder(nested, 'c', 'after')).toBeUndefined();
  });
});
