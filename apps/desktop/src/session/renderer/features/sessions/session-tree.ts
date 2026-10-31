export type SessionTreeItem = {
  id: string;
  parentSessionId?: string | null;
};

export type SessionTreeNode<T extends SessionTreeItem> = {
  item: T;
  children: SessionTreeNode<T>[];
};

/**
 * Build a stable forest. Invalid, missing, and cyclic parents become roots.
 *
 * #5665 父子不必同一项 task:一个任务 = 一个会话,spawn 出来的子会话各住一项 task(与父会话同一个工作
 * 目录)。❌ 再按 conversationId 把跨 task 的孩子拆成根 —— 那等于每个子会话都在侧栏里跟父会话分家。
 */
export function buildSessionTree<T extends SessionTreeItem>(
  items: readonly T[]
): SessionTreeNode<T>[] {
  const nodes = new Map<string, SessionTreeNode<T>>();
  for (const item of items) nodes.set(item.id, { item, children: [] });

  const roots: SessionTreeNode<T>[] = [];
  // Overlapping startup snapshots can contain the same session more than once.
  // Attach only the canonical (latest) node, or duplicate React keys can leave
  // orphan sidebar rows behind when the snapshots converge (#574).
  for (const node of nodes.values()) {
    const item = node.item;
    const parentId = item.parentSessionId;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (!parent || parentId === item.id) {
      roots.push(node);
      continue;
    }

    // Follow the candidate parent chain before attaching so malformed persisted data
    // cannot create a cycle in the renderer.
    let cursor: SessionTreeNode<T> | undefined = parent;
    let valid = true;
    while (cursor) {
      if (cursor.item.id === item.id) {
        valid = false;
        break;
      }
      const nextId: string | null | undefined = cursor.item.parentSessionId;
      cursor = nextId ? nodes.get(nextId) : undefined;
    }
    if (valid) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** 一家子跟着根走:整棵树归根那一格(桌面侧栏的行、手机的机器与项目分区);❌ 按子会话自己的项目 / 机器拆开。 */
export function familiesByRoot<T extends SessionTreeItem, K>(
  roots: readonly SessionTreeNode<T>[],
  cellOf: (root: T) => K
): Map<K, SessionTreeNode<T>[]> {
  const cells = new Map<K, SessionTreeNode<T>[]>();
  for (const root of roots) {
    const key = cellOf(root.item);
    const cell = cells.get(key);
    if (cell) cell.push(root);
    else cells.set(key, [root]);
  }
  return cells;
}

/** 一格里先露出来的闲置家族数;多的收进「展开显示」。 */
export const IDLE_VISIBLE_CAP = 5;

/**
 * 「展开显示」的折法(桌面项目行、桌面「任务」分区、手机项目分区共用):单位是家族(根),❌ 摊平后的行 ——
 * 按行截会把展开的家族拦腰截断。家族里有一个不闲置(需要你 / 在跑)整家就永远露着;闲置的家族按原次序留前
 * IDLE_VISIBLE_CAP 个,其余收起(`expanded` 时全露)。次序不变。`folded` = 收起的家族数,与展开与否无关。
 */
export function foldIdleFamilies<T extends SessionTreeItem>(
  roots: readonly SessionTreeNode<T>[],
  isIdle: (item: T) => boolean,
  expanded: boolean
): { shown: SessionTreeNode<T>[]; folded: number } {
  const idleFamily = (node: SessionTreeNode<T>): boolean => isIdle(node.item) && node.children.every(idleFamily);
  let idleSeen = 0;
  const shown = roots.filter((root) => !idleFamily(root) || ++idleSeen <= IDLE_VISIBLE_CAP || expanded);
  return { shown, folded: Math.max(0, idleSeen - IDLE_VISIBLE_CAP) };
}

/** 置顶的子树整棵离开原处(桌面侧栏与手机会话页同一条口径);`isPinned` 缺席 = 不知道,按没置顶处理。 */
export function withoutPinnedSubtrees<T extends SessionTreeItem & { isPinned?: boolean }>(
  roots: readonly SessionTreeNode<T>[]
): SessionTreeNode<T>[] {
  return roots.flatMap((node) =>
    node.item.isPinned === true
      ? []
      : [{ item: node.item, children: withoutPinnedSubtrees(node.children) }]
  );
}

export function pinnedSubtreeRoots<T extends SessionTreeItem & { isPinned?: boolean }>(
  roots: readonly SessionTreeNode<T>[]
): SessionTreeNode<T>[] {
  return roots.flatMap((node) =>
    node.item.isPinned === true ? [node] : pinnedSubtreeRoots(node.children)
  );
}

export type FlattenedSessionTree<T extends SessionTreeItem> = {
  item: T;
  depth: number;
  hasChildren: boolean;
};

export function flattenSessionTree<T extends SessionTreeItem>(
  roots: readonly SessionTreeNode<T>[],
  expanded: ReadonlySet<string>
): FlattenedSessionTree<T>[] {
  const rows: FlattenedSessionTree<T>[] = [];
  const visit = (node: SessionTreeNode<T>, depth: number) => {
    rows.push({ item: node.item, depth, hasChildren: node.children.length > 0 });
    if (!expanded.has(node.item.id)) return;
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

/** Keep ancestors needed to navigate to a matching descendant. */
export function filterSessionTree<T extends SessionTreeItem>(
  roots: readonly SessionTreeNode<T>[],
  matches: (item: T) => boolean
): SessionTreeNode<T>[] {
  const filter = (node: SessionTreeNode<T>): SessionTreeNode<T> | null => {
    const children = node.children
      .map(filter)
      .filter((child): child is SessionTreeNode<T> => child !== null);
    if (!matches(node.item) && children.length === 0) return null;
    return { item: node.item, children };
  };
  return roots.map(filter).filter((root): root is SessionTreeNode<T> => root !== null);
}
