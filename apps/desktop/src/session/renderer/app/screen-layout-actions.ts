import { observable, reaction, runInAction } from 'mobx';
import { appPlacementStore } from '@renderer/features/extensions/app-placement-store';
import type { PaneEdge } from '@renderer/features/tabs/pane-layout-tree';
import { toast } from '@renderer/lib/hooks/use-toast';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { getSessionPageStore } from '@renderer/features/sessions/stores/session-selectors';
import { openSessionInSessionWhenReady } from '@renderer/features/sessions/open-session-in-session';
import { MIN_PANE_HEIGHT_PX, MIN_PANE_WIDTH_PX } from '@renderer/features/tabs/pane-layout-store';
import { minExtent } from '@renderer/features/tabs/pane-layout-tree';
import { auxWindows, type TabWindowHome } from './aux-windows';
import { MAX_SCREEN_BLOCKS, screenLayout, type ScreenBlockContent, type ScreenLayoutSnapshot, type ScreenSession, type WindowableContent } from './screen-layout';

/**
 * 这一屏(screen-layout)和导航之间的那两根线(spec session-page「一屏几块」):
 * 看哪条会话 → 这屏怎么摆;点一块 / 关一块 / 挪一块 → 导航跟到那时正看着的会话。
 * 导航始终指着正看着的会话块,所以命令、快捷键、侧栏高亮照旧只认「当前会话」。
 */

let syncing = false;

/** 这屏怎么摆存在本机(和 App 摆在哪同一处):重启之后几块并排照旧。 */
const STORAGE_KEY = 'gugu.screen-layout.v1';

function loadScreenLayout(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const snapshot = JSON.parse(raw) as ScreenLayoutSnapshot;
    // 一个 App 只有一份:读回来时它已经摆在某条会话里(最后那一下没来得及存这屏),那块不要。收起来的组同理。
    const withoutPlacedApps = <T extends { blocks: ScreenLayoutSnapshot['blocks'] }>(group: T): T => ({
      ...group,
      blocks: Object.fromEntries(
        Object.entries(group.blocks ?? {}).filter(([, block]) => block?.kind !== 'app' || !appPlacementStore.of(block.tabKind))
      ),
    });
    screenLayout.restore({
      ...withoutPlacedApps(snapshot),
      parked: Array.isArray(snapshot.parked) ? snapshot.parked.map(withoutPlacedApps) : undefined,
    });
  } catch {
    // 读不出来就从一块开始:❌ 不让一条坏掉的记录把会话页拖垮。
  }
}

function saveScreenLayout(snapshot: ScreenLayoutSnapshot | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (snapshot) localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 存不进去只是重启后忘了怎么摆,本次照常。
  }
}

/**
 * 一个项目的任务列表载完了(冷启动挂载那一刻,和导航补跑校验同一处):这屏上属于它的会话块核一次,
 * 会话已经没了(删了、归档了)那块收掉 —— 读回来的摆法里可能有。`exists` 由调用方按那份列表判。
 */
export function revalidateScreenSessions(projectId: string, exists: (sessionId: string) => boolean): void {
  for (const block of screenLayout.sessions) {
    if (block.projectId === projectId && !exists(block.sessionId)) forgetSessionOnScreen(block.sessionId);
  }
  // 收起来的组里也核一次:那组少了它,不到两块就散了。
  for (const block of screenLayout.parkedContents) {
    if (block.kind === 'session' && block.projectId === projectId && !exists(block.sessionId)) screenLayout.forgetSession(block.sessionId);
  }
}

/** 占着一块(这屏上,或收起来的组里)/ 一扇窗的 App(页签类型)。 */
export function appsOnScreen(): string[] {
  const kinds: string[] = [];
  for (const blockId of screenLayout.order) {
    const block = screenLayout.blocks.get(blockId);
    if (block?.kind === 'app') kinds.push(block.tabKind);
  }
  for (const block of screenLayout.parkedContents) if (block.kind === 'app') kinds.push(block.tabKind);
  for (const window of auxWindows.windows.values()) if (window.content.kind === 'app') kinds.push(window.content.tabKind);
  return kinds;
}

/** 占着一块的 App 停用了、卸载了(或读回来时已经不在了):那块收掉,❌ 留一块空着的。 */
function pruneGoneApps(): void {
  reaction(
    () => {
      if (!installedExtensionsStore.isLoaded) return '';
      const enabled = new Set<string>(installedExtensionsStore.residentTabContributions.map((entry) => entry.kind));
      return appsOnScreen()
        .filter((kind) => !enabled.has(kind))
        .join('\n');
    },
    // 收的那一下会动导航、动这屏:放在只读的那半之外,❌ 让它反过来追踪导航。
    (gone) => {
      if (gone) for (const kind of gone.split('\n')) takeAppOffScreen(kind);
    },
    { fireImmediately: true }
  );
}

/** 导航到一条会话(点左边一行、通知、新建完落地、后退)= 这屏把它摆出来。幂等;要赶在会话页第一次渲染之前装上。 */
export function ensureScreenLayoutSync(): void {
  if (syncing) return;
  syncing = true;
  loadScreenLayout();
  reaction(() => screenLayout.snapshot, saveScreenLayout, { delay: 300 });
  // 拖分隔条这类连续变化攒一下再存;关窗、重载前把最后一下存上(和 App 摆在哪那张表对得上)。
  window.addEventListener('pagehide', () => saveScreenLayout(screenLayout.snapshot));
  pruneGoneApps();
  // 左边列表把拼成一组的几条画成一个框(spec session-page「拼在一屏的几块是一组」):列表自己不认这屏,由这里喂。
  reaction(
    () => screenLayout.sessionGroups,
    (groups) => sidebarStore.setJoinedGroups(groups),
    { fireImmediately: true }
  );
  reaction(
    () => {
      const navigation = appState.navigation;
      return navigation.currentViewId === 'session'
        ? (navigation.viewParamsStore.session as Partial<ScreenSession> | undefined)
        : undefined;
    },
    (params) => {
      if (!params?.projectId || !params.sessionId) return;
      // 它开在单独的窗口里:把那扇窗提到前面,这屏不动(一个会话只在一处)。
      const windowed = auxWindows.windowOfSession(params.sessionId);
      if (windowed) {
        if (auxWindows.focusedWindowId !== windowed.id) windowed.handle?.focus();
        return;
      }
      screenLayout.show({ projectId: params.projectId, sessionId: params.sessionId });
    },
    { fireImmediately: true }
  );
  // 看一个项目(点左边项目那一行、新建项目落地)= 这屏把它那一块摆出来,和看一条会话同一个规矩。
  // 几台机器上的同一个项目在左边是一行(绑在同一个群上):认那一行,❌ 同一个项目摆两块。
  reaction(
    () => {
      const navigation = appState.navigation;
      return navigation.currentViewId === 'project'
        ? (navigation.viewParamsStore.project as { projectId?: string } | undefined)?.projectId
        : undefined;
    },
    (projectId) => {
      if (projectId) screenLayout.show({ kind: 'project', projectId: sidebarStore.rowProjectIdOf(projectId) });
    },
    { fireImmediately: true }
  );
  // 回到主窗:导航跟回这屏正看着的那块(焦点在子窗时,导航指着窗里那条会话)。
  window.addEventListener('focus', () => {
    if (auxWindows.focusedWindowId === null) return;
    auxWindows.setFocused(null);
    followFocus();
  });
}

/**
 * 导航跟到正看着的那块(会话块)。正看着 App 那块时导航指着最近看过的会话:它还在这屏上就不动;
 * 不在了(开在窗里、窗刚关掉)就跟到这屏上最近看过的那块会话 —— 导航那一下会把会话块当成正看着的,还给 App。
 */
function followFocus(): void {
  const navigation = appState.navigation;
  // 正看着项目块:导航到那个项目(左边那一行高亮、新建会话预选它)。
  const focusedBlock = screenLayout.focusedBlockId ? screenLayout.blocks.get(screenLayout.focusedBlockId) : undefined;
  if (focusedBlock?.kind === 'project') {
    const current = navigation.viewParamsStore.project as { projectId?: string } | undefined;
    const here = navigation.currentViewId === 'project' && !!current?.projectId && sidebarStore.rowProjectIdOf(current.projectId) === focusedBlock.projectId;
    if (!here) navigation.navigate('project', { projectId: focusedBlock.projectId });
    return;
  }
  const current = navigation.viewParamsStore.session as Partial<ScreenSession> | undefined;
  const onScreen = navigation.currentViewId === 'session' && !!current?.sessionId && !!screenLayout.blockOfSession(current.sessionId);
  const focusedId = screenLayout.focusedBlockId;
  const session = screenLayout.focusedSession ?? (onScreen ? undefined : screenLayout.recentSession);
  if (!session) return;
  if (navigation.currentViewId === 'session' && current?.sessionId === session.sessionId) return;
  navigation.navigate('session', session);
  if (focusedId && screenLayout.focusedBlockId !== focusedId && screenLayout.blocks.has(focusedId)) screenLayout.focus(focusedId);
}

/** 在一块里按下 = 看这一块。 */
export function focusScreenBlock(blockId: string): void {
  if (screenLayout.focusedBlockId === blockId) return;
  screenLayout.focus(blockId);
  followFocus();
}

/** 从这屏拿走一块(⋮⋮ 右键「关闭这一块」、页签条右端那枚、一块最后一格关掉)。 */
export function closeScreenBlock(blockId: string): void {
  if (screenLayout.close(blockId)) followFocus();
}

/** 左边框里一行右键「从这一组拿出来」:它在这屏 = 那块拿走;在收起来的组里 = 从那组拿出来。它回到列表原位。 */
export function takeSessionOutOfGroup(sessionId: string): void {
  const blockId = screenLayout.blockOfSession(sessionId);
  if (blockId) closeScreenBlock(blockId);
  else screenLayout.release({ kind: 'session', projectId: '', sessionId });
}

/** 左边框里一行右键「拆开这一组」:各回各位;这组正在屏上 = 只留正看着那块。 */
export function dissolveScreenGroup(sessionId: string): void {
  screenLayout.dissolve(sessionId);
  followFocus();
}

/** 这条会话在不在一组里(左边那行右键要不要摆「从这一组拿出来 / 拆开这一组」)。 */
export function isSessionGrouped(sessionId: string): boolean {
  return screenLayout.isGrouped(sessionId);
}

function fullToast(): void {
  toast({ title: translateSessionMessage('screen.full', { count: MAX_SCREEN_BLOCKS }) });
}

/** 对半分下去,新的一块和旁边那块各剩这么宽 / 高都不到 → 这一排一起均分。 */
const MIN_HALF_WIDTH_PX = 300;
const MIN_HALF_HEIGHT_PX = 220;

function halfWontFit(blockId: string | null, edge: PaneEdge): boolean {
  const rect = blockId ? screenBlockElement(blockId)?.getBoundingClientRect() : undefined;
  if (!rect) return false;
  return edge === 'left' || edge === 'right' ? rect.width / 2 < MIN_HALF_WIDTH_PX : rect.height / 2 < MIN_HALF_HEIGHT_PX;
}

/** ⌘ 点左边一行 = 并排放在正看着那块右边。它开在单独的窗里:把那扇窗提到前面(一个会话只在一处)。 */
export function showSessionBeside(target: ScreenSession): void {
  const windowed = auxWindows.windowOfSession(target.sessionId);
  if (windowed) {
    windowed.handle?.focus();
    return;
  }
  if (!screenLayout.showBeside(target, { even: halfWontFit(screenLayout.focusedBlockId, 'right') })) {
    fullToast();
    return;
  }
  followFocus();
}

/** 把一样东西摆到这屏上(项目、对话;会话走导航):它在哪组就整组回来,否则单独一屏。 */
export function showOnScreen(content: ScreenBlockContent): void {
  screenLayout.show(content);
  followFocus();
}

/** ⌘ 点左边一行(项目、对话、会话都一样):并排放在正看着那块右边;满了提示。 */
export function showBesideOnScreen(content: ScreenBlockContent): void {
  if (content.kind === 'session') {
    showSessionBeside(content);
    return;
  }
  if (!screenLayout.showBeside(content, { even: halfWontFit(screenLayout.focusedBlockId, 'right') })) {
    fullToast();
    return;
  }
  followFocus();
}

/** 贴着 `targetId` 那块的一条边分出一块放它(拖到边上松手、页签右键「单独一块」)。 */
export function placeOnScreen(content: ScreenBlockContent, targetId: string, edge: PaneEdge): boolean {
  if (!screenLayout.canPlaceAt(content, targetId)) {
    if (screenLayout.isFull && !blockOf(content)) fullToast();
    return false;
  }
  // 它在单独的窗里(从窗里拖回来):那扇窗收掉,回到这屏。
  const windowed = auxWindows.windowOf(content);
  if (windowed) auxWindows.remove(windowed.id);
  // 从左边拖来一条不在屏上的会话 = 和点那一行一样:它的对话页签要打开(它的页签之前全关掉过,❌ 拖过来是一块空面板,
  // owner 10-10 实测)。已经在屏上、只是挪位置的不动它的页签。
  const arriving = content.kind === 'session' && !windowed && !blockOf(content) ? content : null;
  screenLayout.placeAt(content, targetId, edge, { even: halfWontFit(targetId, edge) });
  if (arriving) openSessionInSessionWhenReady({ projectId: arriving.projectId, sessionId: arriving.sessionId });
  // 一个 App 只有一份:进了一块,原来摆着它的那条会话自己就不留了(app-placement-sync)。
  if (content.kind === 'app') appPlacementStore.take(content.tabKind);
  followFocus();
  return true;
}

/** 屏上一块都不剩了(最后那块是 App、它被收走;装着它的窗关了):摆回最近看过的那条会话(它不在窗里的话)。 */
function refillScreen(): void {
  if (screenLayout.layout) return;
  const last = appState.navigation.viewParamsStore.session as Partial<ScreenSession> | undefined;
  if (!last?.projectId || !last.sessionId || auxWindows.windowOfSession(last.sessionId)) return;
  screenLayout.show({ projectId: last.projectId, sessionId: last.sessionId });
}

/** 这个项目删掉了:它那块收掉(收起来的组里也一样);屏上空了就摆回最近看过的会话。 */
export function forgetProjectOnScreen(projectId: string): void {
  screenLayout.forgetContent({ kind: 'project', projectId });
  refillScreen();
  followFocus();
}

/** 这个 App 不在一块里、也不在单独的窗里了:× 收起、退出、停用、被放进某条会话或新建任务页的面板。 */
export function takeAppOffScreen(tabKind: string): void {
  const windowed = auxWindows.windowOfApp(tabKind);
  if (windowed) auxWindows.remove(windowed.id);
  if (!screenLayout.blockOfApp(tabKind)) return;
  screenLayout.forgetApp(tabKind);
  refillScreen();
  followFocus();
}

// ── 单独成窗(spec session-page「一屏几块」:一整块、一个 App 都能单独成窗;窗口怎么叠交给系统) ──

/**
 * 在新窗口打开(⋮⋮ 右键、App 页签右键、左栏 App 右键、拖到窗口外):从这屏拿走 —— 那块收掉;它是屏上唯一一块,
 * 这屏留一句「开在单独的窗口里」—— 再开一扇窗装它。已经在窗里 = 把那扇窗提到前面。
 * `at`:拖到窗口外松手的那一点(屏幕坐标),新窗开在那里。
 */
export function openInWindow(content: WindowableContent, at?: { screenX: number; screenY: number }): void {
  const existing = auxWindows.windowOf(content);
  if (existing) {
    existing.handle?.focus();
    return;
  }
  const blockId = blockOf(content);
  const origin = blockId ? screenLayout.originOf(blockId) : null;
  // 它在收起来的组里(左边那行右键「在新窗口打开」):从那组拿出来 —— 一条会话只在一处。
  if (!blockId) screenLayout.release(content);
  if (content.kind === 'app') {
    appPlacementStore.take(content.tabKind);
    if (blockId) takeAppOffScreen(content.tabKind);
  } else if (blockId) {
    if (screenLayout.order.length > 1) closeScreenBlock(blockId);
    else screenLayout.forgetSession(content.sessionId);
  }
  auxWindows.add(content, at, origin);
}

/**
 * 窗里那枚「放回咕咕」:回到原来那块的位置(开窗前它挨着的那块还在,就贴回那一边);原处没了放在正看着那块右边。
 * 屏上没有块:会话就是唯一一块,App 整页打开;满了:会话换掉正看着的会话块,App 整页打开。导航跟到它。
 */
export function putBackFromWindow(windowId: string): void {
  const window = auxWindows.remove(windowId);
  if (!window) return;
  const content = window.content;
  // 一枚页签:回到它那条会话原来那一格,再去看那条会话(它在一块里就是那一块,在窗里就是那扇窗)。
  if (content.kind === 'tab') {
    content.home.returnFromWindow(content.paneId, { activate: true });
    appState.navigation.navigate('session', { projectId: content.projectId, sessionId: content.sessionId });
    return;
  }
  // 回到原处:它原来挨着的那块还在,就贴回那一边;不在了,放在正看着那块右边。
  const origin = window.origin && screenLayout.blocks.has(window.origin.neighborId) ? window.origin : null;
  const target = origin?.neighborId ?? screenLayout.focusedBlockId ?? screenLayout.order[0];
  const edge = origin?.edge ?? 'right';
  if (content.kind === 'session') {
    if (!target || screenLayout.isFull) screenLayout.show(content);
    else screenLayout.placeAt(content, target, edge, { even: halfWontFit(target, edge) });
    appState.navigation.navigate('session', { projectId: content.projectId, sessionId: content.sessionId });
    return;
  }
  if (target && !screenLayout.isFull) {
    screenLayout.placeAt(content, target, edge, { even: halfWontFit(target, edge) });
    return;
  }
  const extensionId = installedExtensionsStore.allTabContributions.find((entry) => entry.kind === content.tabKind)?.extensionId;
  if (extensionId) appState.navigation.navigate('app', { appId: extensionId });
}

/** 人把那扇窗关了(红灯、关闭钮):它不在任何地方了 —— 会话仍在左边列表,App 照常启用;这屏空了就摆回最近看过的会话。 */
export function windowClosed(windowId: string): void {
  const window = auxWindows.remove(windowId);
  if (!window) return;
  // 一枚页签的窗关了:页签回到它原来那一格(❌ 连同终端进程一起没了);要关掉它,点它自己的 ×。
  if (window.content.kind === 'tab') {
    window.content.home.returnFromWindow(window.content.paneId, { activate: false });
    return;
  }
  refillScreen();
  // 导航刚才指着窗里那条会话:跟回这屏(❌ 左边高亮、「当前会话」的命令对着一条哪儿都不在的会话)。
  followFocus();
}

/** 系统焦点到了这扇子窗:快捷键只给它;导航指向窗里那条会话(左边列表高亮、「当前会话」的命令都对着它)。 */
export function windowFocused(windowId: string): void {
  if (auxWindows.focusedWindowId === windowId) return;
  auxWindows.setFocused(windowId);
  // 装一枚页签的窗拿到焦点:导航不动(❌ 为它把那条会话摆上这屏)。
  const content = auxWindows.windows.get(windowId)?.content;
  if (content?.kind === 'session') appState.navigation.navigate('session', { projectId: content.projectId, sessionId: content.sessionId });
}

/** 这条会话没了(归档、删除):它那块收掉,导航跟到还在屏上的那块。返回它是不是屏上唯一一块(那时由调用方带人离开)。 */
export function forgetSessionOnScreen(sessionId: string): boolean {
  const windowed = auxWindows.windowOfSession(sessionId);
  if (windowed) auxWindows.remove(windowed.id);
  for (const window of auxWindows.tabWindowsOfSession(sessionId)) {
    auxWindows.remove(window.id);
    if (window.content.kind === 'tab') window.content.home.returnFromWindow(window.content.paneId, { activate: false });
  }
  const blockId = screenLayout.blockOfSession(sessionId);
  if (!blockId) return false;
  if (screenLayout.order.length > 1) {
    const wasFocused = screenLayout.focusedBlockId === blockId;
    screenLayout.close(blockId);
    if (wasFocused) followFocus();
    return false;
  }
  screenLayout.forgetSession(sessionId);
  return true;
}

/** 点左栏一个 App 的图标,它正占着一块:去会话页、看那一块。 */
export function revealAppBlock(tabKind: string): boolean {
  const windowed = auxWindows.windowOfApp(tabKind);
  if (windowed) {
    windowed.handle?.focus();
    return true;
  }
  // 它在收起来的那组里:把那组摆回来(去看那组里的会话 = 整组回来),再看 App 那块。
  const parkedWith = screenLayout.blockOfApp(tabKind) ? undefined : screenLayout.parkedSessionOfApp(tabKind);
  if (parkedWith) {
    screenLayout.show(parkedWith);
    appState.navigation.navigate('session', parkedWith);
  }
  const blockId = screenLayout.blockOfApp(tabKind);
  if (!blockId) return false;
  const navigation = appState.navigation;
  if (navigation.currentViewId !== 'session') {
    const session = screenLayout.sessions[0] ?? (navigation.viewParamsStore.session as ScreenSession | undefined);
    if (!session) return false;
    navigation.navigate('session', { projectId: session.projectId, sessionId: session.sessionId });
  }
  // 导航那一下会把它的会话块当成正看着的;App 那块在它之后接过来。
  screenLayout.focus(blockId);
  return true;
}

/**
 * 一枚页签单独成窗(页签右键「在新窗口打开」、拖到窗口外松手):从它那一格拿出来,开一扇窗只装它。
 * 会话自己那枚、App 那枚不走这里 —— 它们是一整块(openInWindow)。
 */
export function openTabInWindow(
  session: ScreenSession,
  home: TabWindowHome & { detachToWindow(tabId: string): string | null },
  tabId: string,
  at?: { screenX: number; screenY: number }
): void {
  const paneId = home.detachToWindow(tabId);
  if (!paneId) return;
  auxWindows.add({ kind: 'tab', projectId: session.projectId, sessionId: session.sessionId, paneId, home }, at);
}

/** 要打开的那枚在某扇窗里:把那扇窗提到前面。 */
export function revealTabWindow(paneId: string): void {
  auxWindows.windowOfTabPane(paneId)?.handle?.focus();
}

const blockOf = (content: ScreenBlockContent) => screenLayout.blockOf(content);

// ── 拖到一块的边上,或(App)拖进一格 ──

/**
 * 拖的时候画出来的落点:哪一块的哪一边(那一半)= 在那边分出一块;
 * 或 —— 只给 App 的页签 —— 一条会话里的哪一格 = 放进那一格(spec tab-extensions「放在哪就在哪」,原型「它的页签能拖进任意页签条、任意格子」)。
 * 落在那一格的页签条上还要排到哪:`before` = 插在这一枚前面,null = 排最后(同一条会话里拖页签的规矩:
 * 指着哪枚就插它前面,指着页签右边的空处就排最后)。
 */
export type BlockDrop =
  | { blockId: string; edge: PaneEdge }
  | { blockId: string; paneId: string; strip?: { before: string | null } };

/**
 * 会话落在另一条会话的正中或它的输入框上 = 在那里插一枚 @(spec session-page「把会话拖成 @」)。这里只为把落点画出来:
 * 插进去的是落点自己的原生 drop(聊天区 / 输入框 / 终端),`sessionId` 是那块输入面绑着的会话。
 */
export type MentionDrop = { blockId: string; mention: { sessionId: string } };

export const blockDropPreview = observable.box<BlockDrop | MentionDrop | null>(null, { deep: false });

const dropKey = (drop: BlockDrop | MentionDrop | null): string =>
  drop
    ? `${drop.blockId}|${'mention' in drop ? `mention:${drop.mention.sessionId}` : 'edge' in drop ? drop.edge : `pane:${drop.paneId}:${drop.strip ? (drop.strip.before ?? 'end') : ''}`}`
    : '';

export function setBlockDropPreview(drop: BlockDrop | MentionDrop | null): void {
  if (dropKey(blockDropPreview.get()) === dropKey(drop)) return;
  runInAction(() => blockDropPreview.set(drop));
}

/**
 * 离边多近算「边上」:那一向的两成以内(照 dockview 的 `DEFAULT_ACTIVATION_SIZE` 20%);再往里是正中 ——
 * 会话落在正中 = 插 @,App 落在正中 = 进那一格。原来是三成(照原型),正中只剩四成见方,
 * owner 2026-10-15「拖拽一个 session 进来总是分屏」。
 */
const EDGE_SHARE = 0.2;

/**
 * 一块最少要多宽 / 多高:App 那块就是一格(MIN_PANE_WIDTH_PX × MIN_PANE_HEIGHT_PX);会话那块按它里面分好的格子算
 * (左右几格加起来,上下取最大)。分块时两半都要放得下,❌ 把会话里的格子挤到比一格还窄。
 */
export function contentMinExtent(content: ScreenBlockContent, axis: 'width' | 'height'): number {
  const unit = axis === 'width' ? MIN_PANE_WIDTH_PX : MIN_PANE_HEIGHT_PX;
  if (content.kind !== 'session') return unit;
  const paneLayout = getSessionPageStore(content.projectId, content.sessionId)?.viewModel?.paneLayout;
  return paneLayout ? minExtent(paneLayout.layout, axis, unit) : unit;
}

export function blockMinExtent(blockId: string, axis: 'width' | 'height'): number {
  const block = screenLayout.blocks.get(blockId);
  if (!block) return axis === 'width' ? MIN_PANE_WIDTH_PX : MIN_PANE_HEIGHT_PX;
  return contentMinExtent(block, axis);
}

export const screenBlockElement = (blockId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-screen-block="${CSS.escape(blockId)}"]`);

/**
 * 指针在 (x, y) 时把 `content` 放下去会落在哪:一块的四条边(离哪条边近就是哪边)= 分出一块;
 * 一条会话那块的页签条或中间 —— 只有 App 能落 —— = 指针下那一格。它自己那块、满了又不能进格、太窄分不开、
 * 会话落在别的会话中间 —— 都是 null,这里不画落点(会话落在中间是插 @:那由指针下的输入面判,见 screenDropHandlers)。
 */
export function resolveBlockDrop(x: number, y: number, content: ScreenBlockContent): BlockDrop | null {
  for (const blockId of screenLayout.order) {
    const element = screenBlockElement(blockId);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
    if (blockOf(content) === blockId) return null;
    // 页签条压在上边沿里面:指着页签条 = 进那一条(排到哪),❌ 当成往上分一块。
    if (content.kind === 'app' && document.elementsFromPoint(x, y).some((el) => el.closest('[data-screen-page] .session-tab-bar'))) {
      return paneDropAt(x, y, blockId, content.tabKind);
    }
    if (screenLayout.canPlaceAt(content, blockId)) {
      const distance: Record<PaneEdge, number> = {
        left: (x - rect.left) / rect.width,
        right: (rect.right - x) / rect.width,
        top: (y - rect.top) / rect.height,
        bottom: (rect.bottom - y) / rect.height,
      };
      const edge = (Object.keys(distance) as PaneEdge[]).reduce((a, b) => (distance[a] <= distance[b] ? a : b));
      const axis = edge === 'left' || edge === 'right' ? 'width' : 'height';
      const splittable = (axis === 'width' ? rect.width : rect.height) >= blockMinExtent(blockId, axis) + contentMinExtent(content, axis) + 1;
      if (distance[edge] <= EDGE_SHARE && splittable) return { blockId, edge };
    }
    return content.kind === 'app' ? paneDropAt(x, y, blockId, content.tabKind) : null;
  }
  return null;
}

/** 指针下是会话那块的哪一格(App 往里放);它已经在那一格里 = null。 */
function paneDropAt(x: number, y: number, blockId: string, tabKind: string): BlockDrop | null {
  const paneLayout = paneLayoutOfBlock(blockId);
  if (!paneLayout) return null;
  for (const element of document.elementsFromPoint(x, y)) {
    const cell = element.closest<HTMLElement>('[data-pane-cell]');
    if (!cell || cell.closest('[data-screen-page]')?.getAttribute('data-screen-page') !== blockId) continue;
    const paneId = cell.dataset.paneCell;
    const pane = paneLayout.groups.find((group) => group.paneId === paneId)?.pane;
    if (!paneId || !pane) return null;
    for (const entry of pane.entries.values()) {
      if (entry.kind === tabKind && !isFileTab(entry.state)) return null;
    }
    if (!element.closest('.session-tab-bar')) return { blockId, paneId };
    const before = element.closest<HTMLElement>('[data-tabid]')?.dataset.tabid ?? null;
    return { blockId, paneId, strip: { before } };
  }
  return null;
}

/** App 打开某个文件的那种页签(一个文件一枚)不是「这个 App」本身。 */
const isFileTab = (state: unknown): boolean => !!(state as { filePath?: string } | undefined)?.filePath;

function paneLayoutOfBlock(blockId: string) {
  const block = screenLayout.blocks.get(blockId);
  return block?.kind === 'session' ? getSessionPageStore(block.projectId, block.sessionId)?.viewModel?.paneLayout : undefined;
}

/** 落下:分出那一块(或挪过去);App 落进一格 = 放到那一格(从原处拿过来,和「+」里点它同一条路)。 */
export function dropOnScreen(drop: BlockDrop, content: ScreenBlockContent): void {
  setBlockDropPreview(null);
  if ('edge' in drop) {
    placeOnScreen(content, drop.blockId, drop.edge);
    return;
  }
  const paneLayout = paneLayoutOfBlock(drop.blockId);
  if (content.kind !== 'app' || !paneLayout) return;
  paneLayout.open(content.tabKind, {}, { preview: false, target: { paneId: drop.paneId } });
  paneLayout.setActiveGroup(drop.paneId);
  const pane = paneLayout.groups.find((group) => group.paneId === drop.paneId)?.pane;
  if (drop.strip && pane) {
    // 下标按 tabOrder 算(reorderTabs 动的就是它);resolvedTabs 会跳过没加载出来的那几枚,拿它算会错一格。
    const order = pane.tabOrder;
    const from = order.findIndex((id) => {
      const entry = pane.entries.get(id);
      return entry?.kind === content.tabKind && !isFileTab(entry.state);
    });
    const target = drop.strip.before ? order.indexOf(drop.strip.before) : order.length;
    if (from >= 0 && target >= 0) pane.reorderTabs(from, from < target ? target - 1 : target);
  }
  if (screenLayout.blocks.has(drop.blockId)) focusScreenBlock(drop.blockId);
}
