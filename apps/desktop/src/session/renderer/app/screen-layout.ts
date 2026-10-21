import { action, computed, makeObservable, observable } from 'mobx';
import {
  cornerPane,
  equalizeAround,
  equalizeSplit,
  insertBeside,
  layoutFor,
  neighbourInOrder,
  paneLeaf,
  paneOrder,
  removePane,
  setSplitSizes,
  snapshotOf,
  type PaneEdge,
  type PaneLayoutNode,
} from '@renderer/features/tabs/pane-layout-tree';
import type { PaneLayoutSnapshotNode } from '@shared/view-state';

/** 一屏最多几块(spec session-page「一屏几块」)。 */
export const MAX_SCREEN_BLOCKS = 4;

export type ScreenSession = { projectId: string; sessionId: string };

/** 一块装的东西:一个会话(连同它分好的格子和页签),或一个 App。 */
export type ScreenBlockContent = ({ kind: 'session' } & ScreenSession) | { kind: 'app'; tabKind: string };

/** 新的一块从旁边那块分走一半;那一半放不下(调用方量过)= 这一排一起均分(照 VS Code 的 splitSizing: auto)。 */
export type InsertOptions = { even?: boolean };

/**
 * 一组的摆法:形状和份额(不带切分的 id,读回时重新编)、每块装什么、正看着哪块;
 * `anchor` = 拼之前正看着的那条会话 —— 左边列表的框摆在它原来的位置(spec session-page「拼在一屏的几块是一组」)。
 */
export type ScreenGroupSnapshot = {
  layout: PaneLayoutSnapshotNode;
  blocks: Record<string, ScreenBlockContent>;
  focused: string | null;
  anchor?: string | null;
};

/** 存下来的:这屏那一组,加上收起来的那些组(不在屏上,点到组里任一条整组回来)。 */
export type ScreenLayoutSnapshot = ScreenGroupSnapshot & { parked?: ScreenGroupSnapshot[] };

/** 左边列表画成一个框的一组:两条会话以上,组员按这组从左上到右下的次序;框摆在 anchor 那条的位置。 */
export type ScreenSessionGroup = { anchor: string; sessionIds: string[]; onScreen: boolean };

let nextBlock = 1;
const newBlockId = () => `block-${nextBlock++}`;

/**
 * 会话页这一屏怎么摆(spec session-page「一屏几块」,#7052):一棵和会话里分格同一种的树,叶子是一块,
 * 一块 = 一个会话或一个 App,最多四块。块没有名字,会话那块认它第一枚页签。
 *
 * 拼在一屏的几块是一组(#7097,照 Arc / Zen 分屏):去看组外的一条 = 这组收起来(`parked`)、那条单独一屏;
 * 去看组里的一条 = 整组摆回来。一条会话、一个 App 只在一组里。只有一块的屏不是组,切走就不用记。
 *
 * 只是摆法,不碰页面:每个会话页一直活在原处(@@@retained-session-pages),这里只说它此刻摆在哪一块 ——
 * 挪块、换块、关块都不重建页面。导航那一侧(看着哪条会话)由 screen-layout-actions 接上。
 */
export class ScreenLayoutStore {
  layout: PaneLayoutNode | null = null;
  readonly blocks = observable.map<string, ScreenBlockContent>({}, { deep: false });
  focusedBlockId: string | null = null;
  /** 最近看过的会话块:正看着 App 那块时,「当前会话」指的是这一块。 */
  lastSessionBlockId: string | null = null;
  /** 这屏这一组拼起来之前正看着的那条会话(左边列表的框摆在它原来的位置);只有一块时没有。 */
  anchorSessionId: string | null = null;
  /** 收起来的组(不在屏上)。 */
  readonly parked = observable.array<ScreenGroupSnapshot>([], { deep: false });

  constructor() {
    makeObservable(this, {
      layout: observable.ref,
      focusedBlockId: observable,
      lastSessionBlockId: observable,
      anchorSessionId: observable,
      order: computed,
      sessions: computed,
      focusedSession: computed,
      sessionGroups: computed,
      show: action,
      showBeside: action,
      placeAt: action,
      close: action,
      forgetSession: action,
      forgetApp: action,
      focus: action,
      setSplitSizes: action,
      equalizeSplit: action,
      restore: action,
      dissolve: action,
      release: action,
    });
  }

  get snapshot(): ScreenLayoutSnapshot | null {
    const parked = [...this.parked];
    if (!this.layout) return parked.length > 0 ? { ...parked[0], parked: parked.slice(1) } : null;
    const current = this.currentGroup()!;
    return parked.length > 0 ? { ...current, parked } : current;
  }

  /**
   * 读回存下的摆法(重启之后):这屏那一组,和收起来的那些组。认不出的块丢掉;这屏一块都不剩就当没存过;
   * 收起来的组不到两块就不再是组。
   */
  restore(snapshot: ScreenLayoutSnapshot): void {
    // 同一条会话、同一个 App 只在一组的一块里:读回来的记录里重了,留先出现的那块(这屏的先读)。
    const seen = new Set<string>();
    const current = readGroup(snapshot, seen);
    if (!current) return;
    const parked = (Array.isArray(snapshot.parked) ? snapshot.parked : []).flatMap((group) => {
      const read = readGroup(group, seen);
      return read && read.entries.length > 1 ? [read] : [];
    });
    this.blocks.replace(current.entries);
    this.layout = current.layout;
    for (const id of [current, ...parked].flatMap((group) => group.entries.map(([blockId]) => blockId))) {
      const n = Number(/^block-(\d+)$/.exec(id)?.[1]);
      if (Number.isFinite(n) && n >= nextBlock) nextBlock = n + 1;
    }
    this.focusedBlockId = null;
    this.lastSessionBlockId = null;
    this.focus(current.focused);
    this.anchorSessionId = current.entries.length > 1 ? current.anchor : null;
    this.parked.replace(
      parked.map((group) => ({
        layout: snapshotOf(group.layout),
        blocks: Object.fromEntries(group.entries),
        focused: group.focused,
        anchor: group.anchor,
      }))
    );
  }

  /** 每一块,从左上到右下。 */
  get order(): string[] {
    return this.layout ? paneOrder(this.layout) : [];
  }

  get isFull(): boolean {
    return this.order.length >= MAX_SCREEN_BLOCKS;
  }

  /** 屏上的会话,和它们各在哪一块。 */
  get sessions(): Array<ScreenSession & { blockId: string }> {
    return this.order.flatMap((blockId) => {
      const block = this.blocks.get(blockId);
      return block?.kind === 'session' ? [{ blockId, projectId: block.projectId, sessionId: block.sessionId }] : [];
    });
  }

  /** 最近看过的那块会话(正看着的会话块;正看着 App 那块 → 之前看过的会话块;再没有 → 任一会话块)。 */
  get recentSession(): ScreenSession | undefined {
    const blockId = this.sessionSlot();
    const block = blockId ? this.blocks.get(blockId) : undefined;
    return block?.kind === 'session' ? { projectId: block.projectId, sessionId: block.sessionId } : undefined;
  }

  /** 正看着的那块是会话块时,它的会话。 */
  get focusedSession(): ScreenSession | undefined {
    const block = this.focusedBlockId ? this.blocks.get(this.focusedBlockId) : undefined;
    return block?.kind === 'session' ? { projectId: block.projectId, sessionId: block.sessionId } : undefined;
  }

  blockOfSession(sessionId: string): string | undefined {
    for (const [blockId, block] of this.blocks) if (block.kind === 'session' && block.sessionId === sessionId) return blockId;
    return undefined;
  }

  blockOfApp(tabKind: string): string | undefined {
    for (const [blockId, block] of this.blocks) if (block.kind === 'app' && block.tabKind === tabKind) return blockId;
    return undefined;
  }

  /**
   * 这一块此刻挨着谁、在它哪一边(拿走之前记下,放回来时回到原处):同一刀里它前面那块 → 在那块的右 / 下边;
   * 它是第一块 → 在后面那块的左 / 上边。屏上只有它一块 = null。
   */
  originOf(blockId: string): { neighborId: string; edge: PaneEdge } | null {
    const visit = (node: PaneLayoutNode): { neighborId: string; edge: PaneEdge } | null => {
      if (node.type === 'pane') return null;
      const at = node.children.findIndex((child) => child.type === 'pane' && child.paneId === blockId);
      if (at >= 0) {
        const horizontal = node.orientation === 'horizontal';
        const before = node.children[at - 1];
        if (before) return { neighborId: paneOrder(before).at(-1)!, edge: horizontal ? 'right' : 'bottom' };
        const after = node.children[at + 1];
        if (after) return { neighborId: paneOrder(after)[0], edge: horizontal ? 'left' : 'top' };
        return null;
      }
      for (const child of node.children) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    return this.layout ? visit(this.layout) : null;
  }

  /** 这一块在屏的哪个角上:左上那块让开展开侧栏的钮,右上那块让开窗口控制。 */
  corners(blockId: string): { topLeft: boolean; topRight: boolean } {
    if (!this.layout) return { topLeft: true, topRight: true };
    return { topLeft: cornerPane(this.layout, 'top-left') === blockId, topRight: cornerPane(this.layout, 'top-right') === blockId };
  }

  /**
   * 左边列表要画成框的组:这屏这一组和收起来的那些组里,两条会话以上的(只拼了一个 App 的不画框 —— 列表里本来就没有 App)。
   */
  get sessionGroups(): ScreenSessionGroup[] {
    const groups: ScreenSessionGroup[] = [];
    const add = (sessionIds: string[], anchor: string | null | undefined, onScreen: boolean) => {
      if (sessionIds.length < 2) return;
      groups.push({ anchor: anchor && sessionIds.includes(anchor) ? anchor : sessionIds[0], sessionIds, onScreen });
    };
    add(this.sessions.map((entry) => entry.sessionId), this.anchorSessionId, true);
    for (const group of this.parked) add(sessionIdsOf(group), group.anchor, false);
    return groups;
  }

  /**
   * 看这条会话(点左边一行、通知点开、新建完落地……,spec session-page「拼在一屏的几块是一组」):
   * 它在这屏 → 那块成为正看着的;在收起来的某一组 → 这屏收起来、那组整组摆回来,正看着它那块;
   * 哪组都不在 → 这屏收起来,它单独一屏。❌ 只换掉正看着的那一块。
   */
  show(target: ScreenSession): void {
    const at = this.blockOfSession(target.sessionId);
    if (at) {
      this.focus(at);
      return;
    }
    const group = this.parked.find((entry) => Object.values(entry.blocks).some((block) => isSession(block, target.sessionId)));
    this.park();
    if (group) {
      this.unpark(group);
      const blockId = this.blockOfSession(target.sessionId);
      if (blockId) this.focus(blockId);
      return;
    }
    const blockId = newBlockId();
    this.blocks.set(blockId, { kind: 'session', projectId: target.projectId, sessionId: target.sessionId });
    this.layout = paneLeaf(blockId);
    this.focus(blockId);
  }

  /**
   * ⌘ 点左边一行:拼进这屏,放在正看着那块的右边。已经在屏上 = 去那块;满了 = 不放(返回 false);
   * 它在收起来的别的组里 = 从那组挪过来(一条只在一组里)。
   */
  showBeside(target: ScreenSession, options: InsertOptions = {}): boolean {
    if (!this.layout || this.blockOfSession(target.sessionId)) {
      this.show(target);
      return true;
    }
    if (this.isFull) return false;
    const content: ScreenBlockContent = { kind: 'session', projectId: target.projectId, sessionId: target.sessionId };
    this.release(content);
    this.insert(content, this.focusedBlockId ?? this.order[0], 'right', options);
    return true;
  }

  /** 拖到 `targetId` 那块的边上能不能接:不是它自己那块,而且屏上还有地方(它本来就在屏上 = 挪,总有地方)。 */
  canPlaceAt(content: ScreenBlockContent, targetId: string): boolean {
    if (!this.blocks.has(targetId)) return false;
    const from = this.blockOf(content);
    if (from === targetId) return false;
    return from !== undefined || !this.isFull;
  }

  /**
   * 贴着 `targetId` 那块的一条边分出一块放它;它本来在别的块 = 那块挪过来(带着它分好的格子);
   * 它在收起来的别的组里 = 从那组挪过来。
   */
  placeAt(content: ScreenBlockContent, targetId: string, edge: PaneEdge, options: InsertOptions = {}): boolean {
    if (!this.layout || !this.canPlaceAt(content, targetId)) return false;
    const from = this.blockOf(content);
    if (from) {
      this.layout = removePane(this.layout, from);
      this.blocks.delete(from);
      if (this.lastSessionBlockId === from) this.lastSessionBlockId = null;
    } else {
      this.release(content);
    }
    this.insert(content, targetId, edge, options);
    return true;
  }

  /**
   * 从这一组拿出一块(块右上 ×、左边那行右键「从这一组拿出来」;它回到左边列表原位)。只剩一块时不拿:屏上总有一块。
   * 正看着的被拿走,看它旁边那块。拿完只剩一块 = 这组散了。
   */
  close(blockId: string): boolean {
    if (!this.layout || this.order.length <= 1 || !this.blocks.has(blockId)) return false;
    const next = neighbourInOrder(this.layout, blockId, 'after') ?? neighbourInOrder(this.layout, blockId, 'before');
    this.layout = removePane(this.layout, blockId);
    this.blocks.delete(blockId);
    if (this.lastSessionBlockId === blockId) this.lastSessionBlockId = this.sessions[0]?.blockId ?? null;
    if (this.focusedBlockId === blockId) {
      const lastSession = this.lastSessionBlockId;
      this.focus(next && this.blocks.get(next)?.kind === 'session' ? next : (lastSession ?? next ?? this.order[0]));
    }
    this.settleAnchor();
    return true;
  }

  /**
   * 拆开这一组(左边框里一行右键「拆开这一组」):它在这屏 → 只留正看着那块(拆开就是各回各位,正看着的还看着);
   * 收起来的 → 不再记着。
   */
  dissolve(sessionId: string): void {
    if (this.blockOfSession(sessionId)) {
      const keep = this.focusedSession ? this.focusedBlockId! : this.blockOfSession(sessionId)!;
      for (const blockId of this.order) if (blockId !== keep) this.close(blockId);
      return;
    }
    const group = this.parked.find((entry) => Object.values(entry.blocks).some((block) => isSession(block, sessionId)));
    if (group) this.parked.remove(group);
  }

  /** 这条会话在不在一个左边画成框的组里(两条会话以上;一条会话拼一个 App 不画框,右键也不给「拿出来 / 拆开」)。 */
  isGrouped(sessionId: string): boolean {
    return this.sessionGroups.some((group) => group.sessionIds.includes(sessionId));
  }

  /** 这条会话没了(归档、删除):它那块收掉(收起来的组里也一样);它是屏上唯一一块就整屏清空,下一次看谁就从谁开始。 */
  forgetSession(sessionId: string): void {
    const at = this.blockOfSession(sessionId);
    if (at) this.forget(at);
    else this.release({ kind: 'session', projectId: '', sessionId });
  }

  /** 这个 App 不在一块里了(放进了某条会话、退出、停用)。 */
  forgetApp(tabKind: string): void {
    const at = this.blockOfApp(tabKind);
    if (at) this.forget(at);
    else this.release({ kind: 'app', tabKind });
  }

  /** 收起来的组里有没有它(App 停用了要从那组里拿走;点左栏 App 图标要把那组摆回来)。 */
  parkedSessionOfApp(tabKind: string): ScreenSession | undefined {
    const group = this.parked.find((entry) => Object.values(entry.blocks).some((block) => block.kind === 'app' && block.tabKind === tabKind));
    if (!group) return undefined;
    const first = sessionIdsOf(group)[0];
    const block = Object.values(group.blocks).find((entry) => isSession(entry, first));
    return block?.kind === 'session' ? { projectId: block.projectId, sessionId: block.sessionId } : undefined;
  }

  /** 收起来的组里的会话与 App(读回来之后核对它们还在不在)。 */
  get parkedContents(): ScreenBlockContent[] {
    return this.parked.flatMap((group) => Object.values(group.blocks));
  }

  /**
   * 它要去别处(拼进这屏、开成窗、没了):从收起来的那组里拿出来。那组只剩一块 = 散了,不再记着;
   * 拿走的是那组的 anchor → 框改摆在剩下的第一条会话那里。
   */
  release(content: ScreenBlockContent): void {
    const index = this.parked.findIndex((group) => Object.values(group.blocks).some((block) => sameContent(block, content)));
    if (index < 0) return;
    const group = this.parked[index];
    const [blockId] = Object.entries(group.blocks).find(([, block]) => sameContent(block, content))!;
    const rest = Object.entries(group.blocks).filter(([id]) => id !== blockId);
    if (rest.length < 2) {
      this.parked.splice(index, 1);
      return;
    }
    const layout = removePane(layoutFor(Object.keys(group.blocks), group.layout), blockId);
    const next: ScreenGroupSnapshot = {
      layout: snapshotOf(layout),
      blocks: Object.fromEntries(rest),
      focused: group.focused === blockId ? paneOrder(layout)[0] : group.focused,
      anchor: group.anchor,
    };
    next.anchor = anchorOf(next);
    this.parked.splice(index, 1, next);
  }

  focus(blockId: string): void {
    if (!this.blocks.has(blockId)) return;
    this.focusedBlockId = blockId;
    if (this.blocks.get(blockId)?.kind === 'session') this.lastSessionBlockId = blockId;
  }

  setSplitSizes(splitId: string, sizes: readonly number[]): void {
    if (this.layout) this.layout = setSplitSizes(this.layout, splitId, sizes);
  }

  equalizeSplit(splitId: string): void {
    if (this.layout) this.layout = equalizeSplit(this.layout, splitId);
  }

  private forget(blockId: string): void {
    if (this.order.length > 1) {
      this.close(blockId);
      return;
    }
    this.clearScreen();
  }

  private clearScreen(): void {
    this.layout = null;
    this.blocks.clear();
    this.focusedBlockId = null;
    this.lastSessionBlockId = null;
    this.anchorSessionId = null;
  }

  private currentGroup(): ScreenGroupSnapshot | null {
    if (!this.layout) return null;
    return {
      layout: snapshotOf(this.layout),
      blocks: Object.fromEntries(this.blocks),
      focused: this.focusedBlockId,
      anchor: this.anchorSessionId,
    };
  }

  /**
   * 这屏收起来(要去看别的组 / 别的会话):两块以上、里面有会话,才是一组、记着(要靠点组里的会话才摆得回来);
   * 只有一块 = 那条会话自己,不用记;只有 App 没有会话 = 点不回来,不记(App 照常启用,左栏点它就开)。
   */
  private park(): void {
    const current = this.currentGroup();
    if (current && this.order.length > 1 && this.sessions.length > 0) this.parked.push(current);
    this.clearScreen();
  }

  /** 收起来的那组整组摆回这屏。 */
  private unpark(group: ScreenGroupSnapshot): void {
    this.parked.remove(group);
    const entries = Object.entries(group.blocks);
    this.blocks.replace(entries);
    this.layout = layoutFor(
      entries.map(([id]) => id),
      group.layout
    );
    this.anchorSessionId = anchorOf(group);
    this.focus(group.focused && this.blocks.has(group.focused) ? group.focused : this.order[0]);
  }

  /** 框摆在哪条会话的位置:拼之前正看着的那条;它被拿走了 → 剩下的第一条会话;不到两块不是组。 */
  private settleAnchor(): void {
    if (this.order.length < 2) {
      this.anchorSessionId = null;
      return;
    }
    const sessions = this.sessions.map((entry) => entry.sessionId);
    if (!this.anchorSessionId || !sessions.includes(this.anchorSessionId)) this.anchorSessionId = sessions[0] ?? null;
  }

  private blockOf(content: ScreenBlockContent): string | undefined {
    return content.kind === 'session' ? this.blockOfSession(content.sessionId) : this.blockOfApp(content.tabKind);
  }

  /** 「当前会话」那块:正看着的会话块;正看着 App 那块 → 最近看过的会话块;再没有 → 任一会话块。 */
  private sessionSlot(): string | undefined {
    const focused = this.focusedBlockId ? this.blocks.get(this.focusedBlockId) : undefined;
    if (focused?.kind === 'session') return this.focusedBlockId!;
    if (this.lastSessionBlockId && this.blocks.get(this.lastSessionBlockId)?.kind === 'session') return this.lastSessionBlockId;
    return this.sessions[0]?.blockId;
  }

  private insert(content: ScreenBlockContent, targetId: string, edge: PaneEdge, { even = false }: InsertOptions = {}): void {
    // 一块变两块 = 拼成一组:框摆在拼之前正看着的那条会话的位置(那块是 App → 摆在拼进来的这条那里)。
    if (this.anchorSessionId === null && this.order.length === 1) {
      this.anchorSessionId = this.sessions[0]?.sessionId ?? (content.kind === 'session' ? content.sessionId : null);
    }
    const blockId = newBlockId();
    this.blocks.set(blockId, content);
    this.layout = this.layout ? insertBeside(this.layout, targetId, blockId, edge) : paneLeaf(blockId);
    if (even) this.layout = equalizeAround(this.layout, blockId);
    this.focus(blockId);
    this.settleAnchor();
  }
}

/**
 * 读回一组:认不出的块、别的组已经有了的会话 / App 丢掉(`seen` 跨组共用);一块不剩、超过四块、形状坏了 = 读不出。
 */
function readGroup(
  snapshot: ScreenGroupSnapshot,
  seen: Set<string>
): { entries: Array<[string, ScreenBlockContent]>; layout: PaneLayoutNode; focused: string; anchor: string | null } | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const mine = new Set<string>();
  const entries = Object.entries(snapshot.blocks ?? {}).filter((entry): entry is [string, ScreenBlockContent] => {
    const block = entry[1];
    if (!isBlockContent(block)) return false;
    const key = block.kind === 'session' ? `session:${block.sessionId}` : `app:${block.tabKind}`;
    if (seen.has(key) || mine.has(key) || seen.has(`block:${entry[0]}`) || mine.has(`block:${entry[0]}`)) return false;
    mine.add(key);
    mine.add(`block:${entry[0]}`);
    return true;
  });
  if (entries.length === 0 || entries.length > MAX_SCREEN_BLOCKS) return null;
  let layout: PaneLayoutNode;
  try {
    // 形状先排好再动这屏:记录里的形状坏了会在这一步抛,❌ 留下「块记着、形状没有」的半截(读不出就当没存过)。
    layout = layoutFor(
      entries.map(([id]) => id),
      snapshot.layout
    );
  } catch {
    return null;
  }
  for (const key of mine) seen.add(key);
  const ids = entries.map(([id]) => id);
  const focused = snapshot.focused && ids.includes(snapshot.focused) ? snapshot.focused : paneOrder(layout)[0];
  const group = { layout: snapshotOf(layout), blocks: Object.fromEntries(entries), focused, anchor: snapshot.anchor ?? null };
  return { entries, layout, focused, anchor: anchorOf(group) };
}

/** 一组里的会话,从左上到右下。 */
function sessionIdsOf(group: ScreenGroupSnapshot): string[] {
  return paneOrder(layoutFor(Object.keys(group.blocks), group.layout)).flatMap((blockId) => {
    const block = group.blocks[blockId];
    return block?.kind === 'session' ? [block.sessionId] : [];
  });
}

/** 这组的框摆在哪条会话:记着的那条还在组里就是它,否则第一条会话。 */
function anchorOf(group: ScreenGroupSnapshot): string | null {
  const sessions = sessionIdsOf(group);
  return group.anchor && sessions.includes(group.anchor) ? group.anchor : (sessions[0] ?? null);
}

function isSession(block: ScreenBlockContent, sessionId: string): boolean {
  return block.kind === 'session' && block.sessionId === sessionId;
}

function sameContent(a: ScreenBlockContent, b: ScreenBlockContent): boolean {
  return a.kind === 'session' ? isSession(b, a.sessionId) : b.kind === 'app' && b.tabKind === a.tabKind;
}

function isBlockContent(value: unknown): value is ScreenBlockContent {
  const block = value as Partial<{ kind: string; projectId: string; sessionId: string; tabKind: string }> | null;
  if (!block || typeof block !== 'object') return false;
  if (block.kind === 'session') return typeof block.projectId === 'string' && typeof block.sessionId === 'string';
  return block.kind === 'app' && typeof block.tabKind === 'string';
}

export const screenLayout = new ScreenLayoutStore();
