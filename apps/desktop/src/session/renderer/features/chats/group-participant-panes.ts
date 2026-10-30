import { action, makeObservable, observable } from 'mobx';
import type { JoinedGroup } from '@/lib/sidebarJoinedGroups';
import { contentKey, screenLayout, type ScreenBlockContent, type ScreenLayoutStore } from '@renderer/app/screen-layout';
import type { PaneLayoutNode } from '@renderer/features/tabs/pane-layout-tree';
import { MIN_PANE_WIDTH_PX } from '@renderer/features/tabs/pane-store';

type Placement = { source: ScreenBlockContent; target: ScreenBlockContent };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
const KEY = 'gugu.group-participant-pane.v1';

/** Placement only: closing/replacing this auxiliary block never closes the target's workspace or tabs. */
export class GroupParticipantPanes {
  readonly placements = observable.map<string, Placement>({}, { deep: false });
  rightWidth = 480;
  private accountId: string | null | undefined;
  private storageKey: string | undefined = KEY;

  constructor(readonly screen: ScreenLayoutStore, private storage?: Storage) {
    makeObservable(this, { rightWidth: observable, show: action, hide: action, rememberWidth: action, useAccount: action });
    this.load();
  }

  useAccount(accountId: string | null): void {
    if (this.accountId === accountId) return;
    this.accountId = accountId;
    this.storageKey = accountId ? `${KEY}:${accountId}` : undefined;
    this.placements.clear();
    this.rightWidth = 480;
    this.load();
  }

  private load(): void {
    if (!this.storageKey) return;
    try {
      const saved = JSON.parse(this.storage?.getItem(this.storageKey) ?? 'null');
      if (Number.isFinite(saved?.rightWidth) && saved.rightWidth >= MIN_PANE_WIDTH_PX) this.rightWidth = saved.rightWidth;
      for (const [id, value] of Object.entries(saved?.placements ?? {})) {
        const placement = value as Placement;
        // The screen snapshot is restored later at boot. Retain valid identities, never arbitrary saved content.
        const source = placement?.source;
        const target = placement?.target;
        const validSource = source?.kind === 'chat' ? typeof source.chatId === 'string'
          : source?.kind === 'project' && typeof source.projectId === 'string';
        const validTarget = target?.kind === 'chat' ? typeof target.chatId === 'string'
          : target?.kind === 'session' && typeof target.sessionId === 'string' && typeof target.projectId === 'string';
        if (validSource && validTarget) this.placements.set(id, placement);
      }
    } catch { /* A corrupt preference cannot prevent opening a conversation. */ }
  }

  show(chatId: string, source: ScreenBlockContent, target: ScreenBlockContent, extent?: number): boolean {
    const sourceId = this.screen.blockOf(source);
    if (!sourceId || contentKey(source) === contentKey(target)) return false;
    const previous = this.placements.get(chatId);
    if (previous && contentKey(previous.target) === contentKey(target) && this.pairedTarget(previous)) {
      this.screen.focus(this.screen.blockOf(target)!);
      return true;
    }
    // Check capacity before taking the old participant away.
    const oldId = previous && this.pairedTarget(previous);
    if (!oldId && !this.screen.canPlaceAt(target, sourceId)) return false;
    if (oldId) this.screen.close(oldId);
    if (!this.screen.placeAt(target, sourceId, 'right')) return false;
    for (const [owner, placement] of this.placements) {
      if (contentKey(placement.target) === contentKey(target)) this.placements.delete(owner);
    }
    this.placements.set(chatId, { source, target });
    this.applyWidth(chatId, extent);
    this.save();
    return true;
  }

  hide(chatId: string): boolean {
    const placement = this.placements.get(chatId);
    if (!placement) return false;
    this.placements.delete(chatId);
    const targetId = this.pairedTarget(placement);
    // A group parked elsewhere does not own the same participant now opened independently.
    if (targetId) this.screen.close(targetId);
    this.save();
    return true;
  }

  ownerOf(blockId: string): string | undefined {
    for (const [chatId, placement] of this.placements) {
      if (this.pairedTarget(placement) === blockId) return chatId;
    }
    return undefined;
  }

  rememberWidth(width: number): void {
    if (!Number.isFinite(width) || width < MIN_PANE_WIDTH_PX) return;
    this.rightWidth = width;
    this.save();
  }

  /** The participant is an auxiliary view, not a joined sidebar group with a “split apart” command. */
  joinedGroups(groups: JoinedGroup[]): JoinedGroup[] {
    return groups.flatMap(group => {
      const auxiliary = new Set([...this.placements.values()]
        .filter(one => group.members.includes(contentKey(one.source)))
        .map(one => contentKey(one.target)));
      const members = group.members.filter(key => !auxiliary.has(key));
      return members.length > 1 ? [{ ...group, members }] : [];
    });
  }

  pairIn(node: PaneLayoutNode): { chatId: string; targetIndex: number } | undefined {
    if (node.type !== 'split' || node.orientation !== 'horizontal') return;
    for (const [chatId, placement] of this.placements) {
      const source = this.screen.blockOf(placement.source);
      const target = this.screen.blockOf(placement.target);
      const sourceIndex = node.children.findIndex(child => child.type === 'pane' && child.paneId === source);
      const targetIndex = node.children.findIndex(child => child.type === 'pane' && child.paneId === target);
      if (sourceIndex >= 0 && targetIndex === sourceIndex + 1) return { chatId, targetIndex };
    }
  }

  private pairedTarget(placement: Placement): string | undefined {
    const sourceId = this.screen.blockOf(placement.source);
    const targetId = this.screen.blockOf(placement.target);
    if (!sourceId || !targetId || !this.screen.layout) return;
    const paired = (node: PaneLayoutNode): boolean => {
      if (node.type === 'pane') return false;
      const at = node.children.findIndex(child => child.type === 'pane' && child.paneId === sourceId);
      const next = node.children[at + 1];
      return (node.orientation === 'horizontal' && at >= 0 && next?.type === 'pane' && next.paneId === targetId)
        || node.children.some(paired);
    };
    return paired(this.screen.layout) ? targetId : undefined;
  }

  private applyWidth(chatId: string, extent?: number): void {
    if (!extent || !this.screen.layout) return;
    const visit = (node: PaneLayoutNode): void => {
      if (node.type === 'pane') return;
      const pair = this.pairIn(node);
      if (pair?.chatId === chatId) {
        const at = pair.targetIndex;
        const total = node.sizes[at - 1] + node.sizes[at];
        const minShare = Math.min(0.5, MIN_PANE_WIDTH_PX / extent);
        const right = Math.min(1 - minShare, Math.max(minShare, this.rightWidth / extent)) * total;
        const sizes = [...node.sizes];
        sizes[at - 1] = total - right;
        sizes[at] = right;
        this.screen.setSplitSizes(node.id, sizes);
        return;
      }
      node.children.forEach(visit);
    };
    visit(this.screen.layout);
  }

  private save(): void {
    if (!this.storageKey) return;
    try { this.storage?.setItem(this.storageKey, JSON.stringify({ rightWidth: this.rightWidth, placements: Object.fromEntries(this.placements) })); }
    catch { /* The current window remains usable when preferences cannot be saved. */ }
  }
}

export const groupParticipantPanes = new GroupParticipantPanes(screenLayout, typeof localStorage === 'undefined' ? undefined : localStorage);
