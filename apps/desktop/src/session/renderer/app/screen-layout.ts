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
import { blockKey, type JoinedGroup } from '@/lib/sidebarJoinedGroups';

/** 一屏最多几块(spec session-page「一屏几块」)。 */
export const MAX_SCREEN_BLOCKS = 4;

export type ScreenSession = { projectId: string; sessionId: string };

/**
 * 一块装的东西:一个会话(连同它分好的格子和页签)、一个 App、一个项目(第一枚页签是项目群,gugu-dev#181)
 * 或一个对话(人和用户群)。
 */
export type ScreenBlockContent =
  | ({ kind: 'session' } & ScreenSession)
  | { kind: 'app'; tabKind: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'chat'; chatId: string };

/** 能单独开成一扇窗的:会话、App(项目、对话这一轮只在主窗里)。 */
export type WindowableContent = Extract<ScreenBlockContent, { kind: 'session' | 'app' }>;

/**
 * 一块装的是哪一样(同一样东西只在一组的一块里):会话认会话 id,App 认页签类型,项目认项目 id,对话认对话 id。
 * 左边列表(项目、对话)按同一个键认出一行是组里的哪一块。
 */
export function contentKey(content: ScreenBlockContent): string {
  switch (content.kind) {
    case 'session':
      return blockKey.session(content.sessionId);
    case 'app':
      return blockKey.app(content.tabKind);
    case 'project':
      return blockKey.project(content.projectId);
    case 'chat':
      return blockKey.chat(content.chatId);
  }
}

/** 新的一块从旁边那块分走一半;那一半放不下(调用方量过)= 这一排一起均分(照 VS Code 的 splitSizing: auto)。 */
export type InsertOptions = { even?: boolean };

/**
 * 一组的摆法:形状和份额(不带切分的 id,读回时重新编)、每块装什么、正看着哪块;
 * `anchor` = 拼之前正看着的那块(contentKey)—— 左边列表把这组的几行并在它那一行的位置(spec session-page「拼在一屏的几块是一组」,
 * 定在 lib/sidebarJoinedGroups 的 joinedSlot)。
 */
export type ScreenGroupSnapshot = {
  layout: PaneLayoutSnapshotNode;
  blocks: Record<string, ScreenBlockContent>;
  focused: string | null;
  anchor?: string | null;
};

/** 存下来的:这屏那一组,加上收起来的那些组(不在屏上,点到组里任一条整组回来)。 */
export type ScreenLayoutSnapshot = ScreenGroupSnapshot & { parked?: ScreenGroupSnapshot[] };

let nextBlock = 1;
const newBlockId = () => `block-${nextBlock++}`;

/**
 * 会话页这一屏怎么摆(spec session-page「一屏几块」,#7052):一棵和会话里分格同一种的树,叶子是一块,
 * 一块 = 一个会话或一个 App,最多四块。块没有名字,会话那块认它第一枚页签。
 *
 * 拼在一屏的几块是一组(#7097,照 Arc / Zen 分屏):去看组外的一条 = 这组收起来(`parked`)、那条单独一屏;
 * 去看组里的一条 = 整组摆回来。一样东西只在一组里。只有一块的屏不是组,切走就不用记。
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
  /** 这屏这一组拼起来之前正看着的那块(contentKey;左边列表把这组并在它那一行的位置);只有一块时没有。 */
  anchorKey: string | null = null;
  /** 收起来的组(不在屏上)。 */
  readonly parked = observable.array<ScreenGroupSnapshot>([], { deep: false });

  constructor() {
    makeObservable(this, {
      layout: observable.ref,
      focusedBlockId: observable,
      lastSessionBlockId: observable,
      anchorKey: observable,
      order: computed,
      sessions: computed,
      focusedSession: computed,
      joinedGroups: computed,
      show: action,
      showBeside: action,
      placeAt: action,
      close: action,
      forgetSession: action,
      forgetApp: action,
      forgetContent: action,
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
    this.anchorKey = current.entries.length > 1 ? current.anchor : null;
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

  /** 这样东西此刻在这屏的哪一块(不在 = undefined)。 */
  blockOf(content: ScreenBlockContent): string | undefined {
    const key = contentKey(content);
    for (const [blockId, block] of this.blocks) if (contentKey(block) === key) return blockId;
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
   * 这屏这一组和收起来的那些组,喂给左边列表(项目、对话各把自己有的那几行并在一处,lib/sidebarJoinedGroups):
   * 组员是每一块装的那样东西,不分种类 —— 哪一样在哪个列表里有一行,由那个列表自己认。
   */
  get joinedGroups(): JoinedGroup[] {
    const groups: JoinedGroup[] = [];
    if (this.order.length > 1) {
      const members = this.order.map((blockId) => contentKey(this.blocks.get(blockId)!));
      groups.push({ members, anchor: this.anchorKey ?? members[0], onScreen: true });
    }
    for (const group of this.parked) groups.push({ members: keysOf(group), anchor: anchorOf(group), onScreen: false });
    return groups;
  }

  /**
   * 看这条会话(点左边一行、通知点开、新建完落地……,spec session-page「拼在一屏的几块是一组」):
   * 它在这屏 → 那块成为正看着的;在收起来的某一组 → 这屏收起来、那组整组摆回来,正看着它那块;
   * 哪组都不在 → 这屏收起来,它单独一屏。❌ 只换掉正看着的那一块。
   */
  show(target: ScreenSession | ScreenBlockContent): void {
    const content = asContent(target);
    const at = this.blockOf(content);
    if (at) {
      this.focus(at);
      return;
    }
    const key = contentKey(content);
    const group = this.parked.find((entry) => Object.values(entry.blocks).some((block) => contentKey(block) === key));
    this.park();
    if (group) {
      this.unpark(group);
      const blockId = this.blockOf(content);
      if (blockId) this.focus(blockId);
      return;
    }
    const blockId = newBlockId();
    this.blocks.set(blockId, content);
    this.layout = paneLeaf(blockId);
    this.focus(blockId);
  }

  /**
   * ⌘ 点左边一行:拼进这屏,放在正看着那块的右边。已经在屏上 = 去那块;满了 = 不放(返回 false);
   * 它在收起来的别的组里 = 从那组挪过来(一条只在一组里)。
   */
  showBeside(target: ScreenSession | ScreenBlockContent, options: InsertOptions = {}): boolean {
    const content = asContent(target);
    if (!this.layout || this.blockOf(content)) {
      this.show(content);
      return true;
    }
    if (this.isFull) return false;
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

  /** 这条会话没了(归档、删除):它那块收掉(收起来的组里也一样);它是屏上唯一一块就整屏清空,下一次看谁就从谁开始。 */
  forgetSession(sessionId: string): void {
    this.forgetContent({ kind: 'session', projectId: '', sessionId });
  }

  /** 这个 App 不在一块里了(放进了某条会话、退出、停用)。 */
  forgetApp(tabKind: string): void {
    this.forgetContent({ kind: 'app', tabKind });
  }

  /** 这样东西没了(会话归档删除、App 停用、项目删除):它那块收掉(收起来的组里也一样);是屏上唯一一块就整屏清空。 */
  forgetContent(content: ScreenBlockContent): void {
    const at = this.blockOf(content);
    if (at) this.forget(at);
    else this.release(content);
  }

  /** 收起来的组里的每一块(读回来之后核对它们还在不在;点左栏 App 图标时它在不在某一组里)。 */
  get parkedContents(): ScreenBlockContent[] {
    return this.parked.flatMap((group) => Object.values(group.blocks));
  }

  /**
   * 它要去别处(拼进这屏、开成窗、没了):从收起来的那组里拿出来。那组只剩一块 = 散了,不再记着;
   * 拿走的是那组的 anchor → anchor 改成剩下的第一块。
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
    this.anchorKey = null;
  }

  private currentGroup(): ScreenGroupSnapshot | null {
    if (!this.layout) return null;
    return {
      layout: snapshotOf(this.layout),
      blocks: Object.fromEntries(this.blocks),
      focused: this.focusedBlockId,
      anchor: this.anchorKey,
    };
  }

  /**
   * 这屏收起来(要去看别的组 / 别的会话):两块以上就是一组、记着,装的是什么都一样 —— 点组里任一样(左边的会话行、
   * 对话行、项目行,左栏的 App 图标)整组摆回来;只有一块 = 那一样自己,不用记。
   */
  private park(): void {
    const current = this.currentGroup();
    if (current && this.order.length > 1) this.parked.push(current);
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
    this.anchorKey = anchorOf(group);
    this.focus(group.focused && this.blocks.has(group.focused) ? group.focused : this.order[0]);
  }

  /** 拼之前正看着的那块;它被拿走了 → 剩下的第一块;不到两块不是组。 */
  private settleAnchor(): void {
    if (this.order.length < 2) {
      this.anchorKey = null;
      return;
    }
    const keys = this.order.map((blockId) => contentKey(this.blocks.get(blockId)!));
    if (!this.anchorKey || !keys.includes(this.anchorKey)) this.anchorKey = keys[0];
  }

  /** 「当前会话」那块:正看着的会话块;正看着 App 那块 → 最近看过的会话块;再没有 → 任一会话块。 */
  private sessionSlot(): string | undefined {
    const focused = this.focusedBlockId ? this.blocks.get(this.focusedBlockId) : undefined;
    if (focused?.kind === 'session') return this.focusedBlockId!;
    if (this.lastSessionBlockId && this.blocks.get(this.lastSessionBlockId)?.kind === 'session') return this.lastSessionBlockId;
    return this.sessions[0]?.blockId;
  }

  private insert(content: ScreenBlockContent, targetId: string, edge: PaneEdge, { even = false }: InsertOptions = {}): void {
    // 一块变两块 = 拼成一组:记下拼之前正看着的那块(左边列表把这组并在它那一行的位置)。
    if (this.anchorKey === null && this.order.length === 1) this.anchorKey = contentKey(this.blocks.get(this.order[0])!);
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
    const key = contentKey(block);
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

/** 一组里的每一块装的东西(contentKey),从左上到右下。 */
function keysOf(group: ScreenGroupSnapshot): string[] {
  return paneOrder(layoutFor(Object.keys(group.blocks), group.layout)).flatMap((blockId) => {
    const block = group.blocks[blockId];
    return block ? [contentKey(block)] : [];
  });
}

/** 这组拼之前正看着的那块:记着的那块还在组里就是它,否则第一块。 */
function anchorOf(group: ScreenGroupSnapshot): string {
  const keys = keysOf(group);
  return group.anchor && keys.includes(group.anchor) ? group.anchor : keys[0];
}

function isSession(block: ScreenBlockContent, sessionId: string): boolean {
  return block.kind === 'session' && block.sessionId === sessionId;
}

function sameContent(a: ScreenBlockContent, b: ScreenBlockContent): boolean {
  return contentKey(a) === contentKey(b);
}

/** 只给了会话的那种老调用(看这条会话)= 一块会话。 */
function asContent(target: ScreenSession | ScreenBlockContent): ScreenBlockContent {
  return 'kind' in target ? target : { kind: 'session', projectId: target.projectId, sessionId: target.sessionId };
}

function isBlockContent(value: unknown): value is ScreenBlockContent {
  const block = value as Partial<{ kind: string; projectId: string; sessionId: string; tabKind: string; chatId: string }> | null;
  if (!block || typeof block !== 'object') return false;
  switch (block.kind) {
    case 'session':
      return typeof block.projectId === 'string' && typeof block.sessionId === 'string';
    case 'app':
      return typeof block.tabKind === 'string';
    case 'project':
      return typeof block.projectId === 'string';
    case 'chat':
      return typeof block.chatId === 'string';
    default:
      return false;
  }
}

export const screenLayout = new ScreenLayoutStore();
