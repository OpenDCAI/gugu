import { action, makeObservable, observable } from 'mobx';
import type { PreparedChatFile } from '@shared/extensions/app-runtime-protocol';

/**
 * 常驻扩展的页住在根层(extension-view-layer);会话里那一格、它的整页、群右栏那一格只是它此刻落在哪里。
 *
 * **群里的页从生到死只属于那个群**(摩擦单 F48,`chat:<chatId>`):页的 context 里 chatId 一生不变,
 * App 不用写「我的页换了群」的代码 —— 换到另一个群就是另一张页。
 * **声明了每个任务一份的页签同理**(`perSession`,#7317,`session:<sessionId>`):那张页一生只属于那个任务,
 * 两个任务并排时各是各的;换到另一个任务就是另一张页。
 * **群以外只有一张**(`app`):一个 App 只有一份、放在哪就在哪(behavior tab-extensions,#7052)——
 * 从一条会话挪到另一条、挪去它的整页,都是这同一张页跟过去,不重建;「现在在哪条会话」由 retarget 告诉它
 * (behavior tab-extensions「挪地方、切会话时它纹丝不动」)。
 *
 * 这张表记的是「此刻落在哪里」:按页(App 的 tab 类型 + 地方),当前被哪一格认领着、那一格的 DOM 元素在哪、
 * 它属于哪个任务 / 项目 / 会话 / 群。根层的页据此把自己挪过去并告诉桥「现在是给谁看的」。
 *
 * 页**有人要它才建**:第一次有格认领它的那一刻,❌ 装好就在后台起一张谁也没要的页(摩擦单 F3)。
 * 没人看的页(绑定过的:一次也没绑上就被放下的不留,见 `release`)藏起来活着,回来时立刻就在、原样;每个 App 最多留 RESIDENT_PAGES_KEPT 张没人看的,
 * 再多就销毁最久没用的那张 —— 回到那里时新开一张,群里开着哪个文件由右栏自己记着(摩擦单 F29)。
 *
 * 文件页同样常驻,按地方与文件各一份:回来时保留编辑器和同步副本,从不把另一份文件交给旧页。
 */
export interface ExtensionViewClaim {
  takeOpening?: () => PreparedChatFile | undefined;
  /** 认领方的身份;释放时核对,免得后来者被先前者的卸载误伤。 */
  token: number;
  /** The session this slot is in — absent for a slot in no session (a chat's side panel, the dock). */
  sessionId?: string;
  tabId: string;
  /** 这一格画在哪个对话里(右栏);有它,页的 context 就带上 `chat`(真源原则 13:只是事实,不是目标)。 */
  chatId?: string;
  /** 这一格的页签每个任务一份(manifest `perSession`):页属于 `sessionId` 那个任务,不跟着挪。 */
  perSession?: boolean;
  /**
   * 这一格用这个 App 打开的群文件。页从第一个调用起 context.file 就是它,一生不换文件。
   */
  itemId?: string;
  /** 那一格的内容区。根层量它的框来摆页、报尺寸。 */
  element: HTMLElement;
}

/** 一张常驻页:哪个 App 的哪一类 tab,住在哪个地方。 */
export interface ExtensionResidentPage {
  /** The physical guest's identity, retained when an empty page takes its first file. */
  id: number;
  key: string;
  kind: string;
  /** 群、每任务一份的任务或 App;文件页再带文件的 id。页的一生不变。 */
  place: string;
  itemId?: string;
  empty?: boolean;
}

/** 每个 App 最多留几张没人看的常驻页(有格正认领着的不算,也从不销毁)。 */
export const RESIDENT_PAGES_KEPT = 3;

/**
 * 一格属于的地方:群右栏那一格是它的群;每任务一份的页签在任务里那一格是那个任务;别处(会话里、它的整页)都是群以外那一张。
 * 每任务一份的页签不在任何任务里(整页、单独成窗)时也落到 `app`:那张页知道自己不在任务里,说一句就是。
 */
export function residentPlace(target: { chatId?: string; sessionId?: string; perSession?: boolean; itemId?: string }): string {
  const place = target.chatId ? `chat:${target.chatId}` : target.perSession && target.sessionId ? `session:${target.sessionId}` : 'app';
  return target.itemId ? `${place}:file:${target.itemId}` : place;
}

export function residentPageKey(kind: string, place: string): string {
  return `${kind}\u0000${place}`;
}

let nextToken = 1;
let nextUse = 1;
let nextPage = 1;

function slotKey(sessionId: string | null | undefined, tabId: string): string {
  return `${sessionId ?? ''}\u0000${tabId}`;
}

class ExtensionViewStore {
  /**
   * 按页,**此刻**拿着它的认领方 = 下面那个栈的栈顶。页只画在这一格。
   * 同一时刻只有一个(同一个地方里同类两格是边角情况:后来者顶掉先前者)。
   */
  readonly claims = observable.map<string, ExtensionViewClaim>({}, { deep: false });
  /**
   * 按页的认领栈:还挂着的每一格,按认领先后。栈顶释放,页**还给**下面那一格。
   */
  private readonly stacks = new Map<string, ExtensionViewClaim[]>();
  /** 已经有人要过、此刻活着的常驻页。根层只给这些建页。 */
  readonly residentPages = observable.map<string, ExtensionResidentPage>({}, { deep: false });
  /** 每张常驻页最近一次被认领的先后,销毁最久没用的那张时用。 */
  private readonly usedAt = new Map<string, number>();
  /** 认领 → 它认领的那张常驻页。 */
  private readonly pageOfToken = new Map<number, string>();
  /**
   * 哪些格是常驻页的落点,按(任务, tab)记,**不随认领释放而清**。
   * 认领只在那一格是活动页签时存在;页在后台说的话(角标 / 标题 / 报错)得记到这张页名下,
   * 不然切走一下角标就停了。只有这一格被关掉(provider dispose)才忘。
   */
  private readonly slotPages = observable.map<string, string>({}, { deep: false });
  /** Which page draws a claim once it is bound — token → webContents id — so a slot's toolbar reaches it. */
  private readonly surfaces = new Map<number, number>();
  /** Resident pages bound at least once: only these are kept while nobody looks (see `release`). */
  private readonly boundPages = new Set<string>();

  constructor() {
    makeObservable(this, { claim: action, prepareFile: action, release: action, forgetOpened: action, forgetIdle: action, forgetSlot: action });
  }

  /** The page now drawing this claim is bound (the layer says so). A claim already released: nothing to note. */
  setSurface(token: number, webContentsId: number): void {
    const key = this.pageOfToken.get(token);
    if (!key) return;
    this.surfaces.set(token, webContentsId);
    this.boundPages.add(key);
  }

  /** A host-rendered page is ready without a guest webContents. Keep its draft when the slot moves. */
  setHostPageReady(token: number): void {
    const key = this.pageOfToken.get(token);
    if (key) this.boundPages.add(key);
  }

  /** The page drawing this claim, if it is bound. */
  surfaceFor(token: number): number | null {
    return this.surfaces.get(token) ?? null;
  }

  /**
   * 认领那个地方的页;带 `itemId` 时只认领那个文件的页,和 App 自己的页分开。
   */
  claim(kind: string, target: Omit<ExtensionViewClaim, 'token'>): number {
    const token = nextToken++;
    const claim = { ...target, token };
    const place = residentPlace(claim);
    const key = residentPageKey(kind, place);
    if (!this.residentPages.has(key)) {
      const empty = claim.itemId ? this.residentPages.get(residentPageKey(kind, 'empty')) : undefined;
      if (empty) this.drop(empty.key);
      this.residentPages.set(key, { id: empty?.id ?? nextPage++, key, kind, place, ...(claim.itemId ? { itemId: claim.itemId } : {}) });
    }
    this.usedAt.set(key, nextUse++);
    const stack = this.stacks.get(key) ?? [];
    stack.push(claim);
    this.stacks.set(key, stack);
    this.claims.set(key, claim);
    this.pageOfToken.set(token, key);
    this.slotPages.set(slotKey(target.sessionId, target.tabId), key);
    this.evict(kind);
    return token;
  }

  /** Only when the person opens the group folder: one empty guest, inside the same idle-page limit. */
  prepareFile(kind: string): void {
    const key = residentPageKey(kind, 'empty');
    if (!this.residentPages.has(key)) this.residentPages.set(key, { id: nextPage++, key, kind, place: 'empty', empty: true });
    this.usedAt.set(key, nextUse++);
    this.evict(kind);
  }

  /** 这一格是哪张常驻页的落点(哪怕此刻没在前台)—— 宿主动作(标题 / 角标 / 报错)按此决定记到哪。 */
  pageOfSlot(sessionId: string | null, tabId: string): string | null {
    return this.slotPages.get(slotKey(sessionId, tabId)) ?? null;
  }

  /** 那一格被关掉了。 */
  forgetSlot(sessionId: string | null, tabId: string): void {
    this.slotPages.delete(slotKey(sessionId, tabId));
  }

  release(kind: string, token: number): void {
    this.surfaces.delete(token);
    const key = this.pageOfToken.get(token);
    this.pageOfToken.delete(token);
    const stack = key ? this.stacks.get(key) : undefined;
    const at = stack?.findIndex((claim) => claim.token === token) ?? -1;
    if (!key || !stack || at < 0) return;
    stack.splice(at, 1);
    const top = stack[stack.length - 1];
    if (!top) {
      this.stacks.delete(key);
      this.claims.delete(key);
      // Never bound: its last claim went before the page was ready (the panel went straight on to a file, 摩擦单
      // F10 / F51). It showed nobody anything, and the calls it made while booting went unanswered — main waits
      // BINDING_WAIT_MS for a binding, then refuses them. Kept, it would stay loaded and unbound until someone came
      // back to it, and come back with that boot behind it. It goes; the next claim builds a page afresh.
      if (!this.boundPages.has(key)) this.drop(key);
      this.evict(kind);
    } else if (this.claims.get(key)?.token !== top.token) {
      this.claims.set(key, top);
    }
  }

  /** 这个 App 没人看的常驻页多于 RESIDENT_PAGES_KEPT 张:销毁最久没用的。 */
  private evict(kind: string): void {
    const idle = [...this.residentPages.values()]
      .filter((page) => page.kind === kind && !this.claims.has(page.key))
      .sort((a, b) => (this.usedAt.get(a.key) ?? 0) - (this.usedAt.get(b.key) ?? 0));
    for (const page of idle.slice(0, Math.max(0, idle.length - RESIDENT_PAGES_KEPT))) this.drop(page.key);
  }

  /** 这一类的扩展关掉 / 卸载了:它的常驻页都不算「有人要过」,页随之销毁。 */
  forgetOpened(kind: string): void {
    for (const page of [...this.residentPages.values()]) if (page.kind === kind) this.drop(page.key);
  }

  /** 这一类的 App 退出了(#7050):没人看着、藏着活的页都销毁;还在屏上的那几张留着 —— 它们还摆在那里。 */
  forgetIdle(kind: string): void {
    for (const page of [...this.residentPages.values()]) if (page.kind === kind && !this.claims.has(page.key)) this.drop(page.key);
  }

  private drop(key: string): void {
    this.residentPages.delete(key);
    this.usedAt.delete(key);
    this.boundPages.delete(key);
  }
}

export const extensionViewStore = new ExtensionViewStore();
