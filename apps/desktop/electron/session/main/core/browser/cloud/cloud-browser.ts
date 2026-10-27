import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, safeStorage } from 'electron';
import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';
import { agentSessionContext } from '@main/core/extensions/extension-agent-context';
import { log } from '@main/lib/logger';
import type { AgentBrowserBridgeShape } from '../agent-browser';
import { CdpHub, type CdpEvent } from './cdp-hub';
import { findChrome, launchChrome, openDisplay, type LaunchedChrome } from './chrome';
import { createCloudPageTransport } from './page-transport';
import { CredentialStore, fillLogin, readPasswordValues, siteOf, type Credential, type FillResult } from './vault';
import type {
  CloudBrowserAssistance,
  CloudBrowserAutomation,
  CloudBrowserStatus,
  CloudBrowserTab,
} from '@shared/cloud-browser';

/**
 * #7199 云浏览器:个人助理(和它派的子 agent)在云电脑上用的那一个 Chrome,人在桌面聊天里实时看、能接管。
 *
 * 状态全在这一个对象里(咕咕 server 的账号进程一份):
 *  - 页签:每条会话一个(和桌面会话页「一条会话一个页签」同一条规矩),人接管时开的页签也列在里面;
 *  - 控制权(exclusive):人「接管浏览器」→ agent 的浏览器动作一律拒,直到「交还给 Agent」;agent 正在做一步时
 *    人申请接管 = 等这一步做完再交(界面显示「等待 Agent 完成当前操作…」);
 *  - 自动化:running / idle / stopped。人「停止任务」= agent 之后的浏览器动作一律拒,直到「允许 Agent 继续」;
 *  - 求助:agent 请人登录(密码保险箱)或请人接手一步(验证码、短信码)—— 工具调用挂着,等人做完。
 * 画面、输入、标签页的 websocket 在 live-server.ts;这里只出状态与动作。
 */

const DRIVING_IDLE_MS = 3_000;
/**
 * 页签标题多久对一次:Chrome 只在导航那一刻发 targetInfoChanged,页面随后写的 <title>、单页应用改的标题都不通知
 * (10-15 实测),CDP 也没有标题事件 —— 只能拉 Target.getTargets。
 */
const TAB_REFRESH_MS = 2_000;
/** 求助挂着等人的上限:人一直没来,工具照实交回,❌ 把 agent 的这一轮永远卡住。 */
const ASSISTANCE_WAIT_MS = 10 * 60_000;
/** 人填了但没勾「保存」:多步登录(先账号、下一页才要密码)在这段时间里接着用,❌ 再问一遍。 */
const REMEMBER_UNSAVED_MS = 10 * 60_000;
/** 交还前读密码框的上限:页面卡死也得交还(❌ agent 一直被挡着),读不到的只进日志。 */
const RELEASE_READ_MS = 3_000;

export const TAKEN_OVER_MESSAGE =
  'The person took over the browser (they are using it themselves right now), so browser actions are paused. ' +
  'Do not retry and do not open another browser: tell the person what you have done so far and wait. ' +
  'Browser actions resume when they hand it back (「交还给 Agent」).';

export const STOPPED_MESSAGE =
  'The person stopped this browser task, so browser actions are refused. Do not retry and do not open another browser: ' +
  'tell the person what you did so far. Browser actions resume only after they click 「允许 Agent 继续」 on the browser.';

type ChangeListener = () => void;

type PendingAssistance = CloudBrowserAssistance & {
  sessionId: string;
  settle: (outcome: AssistanceOutcome) => void;
};

type AssistanceOutcome =
  | { kind: 'filled'; fill: FillResult; saved: boolean }
  | { kind: 'returned' }
  | { kind: 'dismissed' }
  | { kind: 'stopped' }
  | { kind: 'timeout' }
  | { kind: 'ended'; reason: string };

export class CloudBrowser {
  private launched: { chrome: LaunchedChrome; hub: CdpHub } | null = null;
  private starting: Promise<CdpHub> | null = null;
  private closing: Promise<void> | null = null;
  private endedReason: string | null = null;
  private readonly tabs = new Map<string, CloudBrowserTab & { lastUsedAt: number }>();
  private readonly sessionTab = new Map<string, string>();
  private readonly inFlight = new Map<string, number>();
  private readonly usedSince = new Set<string>();
  private activeTabId: string | null = null;
  private automation: CloudBrowserAutomation = 'idle';
  private completed = false;
  private lastActivityAt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private tabRefresh: ReturnType<typeof setInterval> | null = null;
  private holder: string | null = null;
  private pendingHolder: string | null = null;
  private assistance: PendingAssistance | null = null;
  private readonly remembered = new Map<string, { credential: Credential; until: number }>();
  /**
   * 填进过页面的密码(各种写法)。Playwright 的页面快照会把密码框的值原样写出来(`textbox "密码": …`,10-15 实测),
   * 所以交回 agent 的每个浏览器工具结果都过一遍 redact —— ❌ 指望 agent 不去看。
   */
  private readonly secrets = new Set<string>();
  private readonly listeners = new Set<ChangeListener>();
  private readonly store: CredentialStore;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly dataDir: string = app.getPath('userData')
  ) {
    this.store = new CredentialStore(path.join(dataDir, 'cloud-browser', 'saved-logins.enc'), () => safeStorage);
    agentStatusWriter.on('agent:status', ({ sessionId, reading }) => {
      if (!this.sessionTab.has(sessionId)) return;
      if (reading.running) {
        if (this.completed) {
          this.completed = false;
          this.notify();
        }
        return;
      }
      // 用过浏览器的那一轮结束了 = 任务完成(界面显示「任务已完成」)。没碰浏览器的轮次 ❌ 算。
      if (this.usedSince.delete(sessionId) && this.totalInFlight() === 0) {
        this.completed = true;
        this.notify();
      }
    });
  }

  /** 这台机器上有没有 Chrome 可用(状态里报给桌面:没有就不出浏览器小窗)。 */
  binary(): string | null {
    return findChrome(this.env);
  }

  hub(): CdpHub | null {
    return this.launched && !this.launched.hub.closed ? this.launched.hub : null;
  }

  sessionIds(): string[] {
    return [...this.sessionTab.keys()];
  }

  tabIdForSession(sessionId: string): string | null {
    return this.sessionTab.get(sessionId) ?? null;
  }

  sessionInUse(sessionId?: string): boolean {
    return (sessionId === undefined ? this.totalInFlight() : this.inFlight.get(sessionId) ?? 0) > 0
      || !!this.holder || !!this.pendingHolder
      || (!!this.assistance && (sessionId === undefined || this.assistance.sessionId === sessionId));
  }

  /** Release the owning task's page, including the last Chrome process. Ordinary tool disconnects keep it. */
  async closeSession(sessionId: string): Promise<void> {
    const targetId = this.sessionTab.get(sessionId);
    const hub = this.hub();
    if (!targetId || !hub) return;
    const { success } = await hub.send<{ success: boolean }>('Target.closeTarget', { targetId });
    if (!success) throw new Error('Chrome did not close the task browser page');
    if (this.sessionTab.get(sessionId) === targetId) this.sessionTab.delete(sessionId);
    this.usedSince.delete(sessionId);
    this.tabs.delete(targetId);
    if (this.activeTabId === targetId) this.activeTabId = this.mostRecentTab();
    if (this.tabs.size === 0 && this.totalInFlight() === 0) {
      this.shutdown();
      await this.closing;
    }
    this.notify();
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        log.warn('Cloud browser: a change listener failed', { error: String(error) });
      }
    }
  }

  // ── Chrome ────────────────────────────────────────────────────────────────

  async ensureHub(): Promise<CdpHub> {
    // The profile is still owned by the retiring process until its actual exit.
    if (this.closing) await this.closing;
    const live = this.hub();
    if (live) return live;
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<CdpHub> {
    const binary = this.binary();
    if (!binary) throw new Error('there is no Chrome or Chromium on this computer, so there is no browser to drive');
    const { display, stop: stopDisplay } = await openDisplay(this.env);
    const account = this.env.GUGU_SERVER_ACCOUNT?.trim() || 'default';
    let chrome: LaunchedChrome | null = null;
    chrome = await launchChrome({
      binary,
      userDataDir: path.join(this.dataDir, 'cloud-browser', 'profile'),
      cacheDir: path.join(os.homedir(), '.cache', 'gugu-cloud-browser', account),
      display,
      env: this.env,
      onExit: (reason) => {
        // Its own Xvfb goes with it (failed starts included: they end in this exit too).
        stopDisplay();
        if (chrome && this.launched?.chrome === chrome) this.ended(reason);
      },
    });
    let hub: CdpHub;
    try {
      hub = await CdpHub.connect(chrome.browserUrl);
    } catch (error) {
      chrome.child.kill();
      throw error;
    }
    this.launched = { chrome, hub };
    this.endedReason = null;
    hub.onClose((reason) => {
      if (this.launched?.hub === hub) this.ended(reason);
    });
    hub.onEvent((event) => this.onTargetEvent(event));
    await hub.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await hub.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
    for (const info of targetInfos) this.upsertTarget(info);
    this.tabRefresh = setInterval(() => void this.refreshTabs(), TAB_REFRESH_MS);
    this.tabRefresh.unref?.();
    log.info('Cloud browser: Chrome is up', { binary, headless: chrome.headless, display, port: chrome.port });
    this.notify();
    return hub;
  }

  /** 停掉 Chrome(咕咕 server 退出时)。 */
  shutdown(): void {
    const launched = this.launched;
    if (launched) this.ended('the task browser was released');
  }

  private ended(reason: string): void {
    if (!this.launched && this.endedReason) return;
    const launched = this.launched;
    this.launched = null;
    this.stopTabRefresh();
    launched?.hub.close();
    if (launched && launched.chrome.child.exitCode === null && launched.chrome.child.signalCode === null) {
      this.closing = new Promise<void>((resolve) => {
        launched.chrome.child.once('exit', () => resolve());
      }).finally(() => { this.closing = null; });
      launched.chrome.child.kill();
    }
    this.endedReason = reason;
    this.tabs.clear();
    this.sessionTab.clear();
    this.activeTabId = null;
    this.holder = null;
    this.pendingHolder = null;
    this.completed = false;
    this.usedSince.clear();
    this.inFlight.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    // 这次浏览器会话结束了,「停止」跟着它结束:下次起来的是新的一次(❌ 卡片收起后没人能放行)。
    this.automation = 'idle';
    this.assistance?.settle({ kind: 'ended', reason });
    log.info('Cloud browser: Chrome is gone', { reason });
    this.notify();
  }

  private onTargetEvent(event: CdpEvent): void {
    if (event.sessionId) return;
    if (event.method === 'Target.targetCreated' || event.method === 'Target.targetInfoChanged') {
      if (this.upsertTarget(event.params.targetInfo as TargetInfo)) this.notify();
    } else if (event.method === 'Target.targetDestroyed') {
      const targetId = String(event.params.targetId);
      if (!this.tabs.delete(targetId)) return;
      for (const [sessionId, owned] of this.sessionTab) if (owned === targetId) this.sessionTab.delete(sessionId);
      if (this.activeTabId === targetId) this.activeTabId = this.mostRecentTab();
      this.notify();
    }
  }

  private async refreshTabs(): Promise<void> {
    const hub = this.hub();
    if (!hub) return;
    let targetInfos: TargetInfo[];
    try {
      ({ targetInfos } = await hub.send<{ targetInfos: TargetInfo[] }>('Target.getTargets'));
    } catch (error) {
      // 连接正在断:onClose 那边会收尾,这里只记一笔。
      log.debug('Cloud browser: could not refresh tabs', { error: String(error) });
      return;
    }
    let changed = false;
    for (const info of targetInfos) if (this.tabs.has(info.targetId) && this.upsertTarget(info)) changed = true;
    if (changed) this.notify();
  }

  private stopTabRefresh(): void {
    if (this.tabRefresh) clearInterval(this.tabRefresh);
    this.tabRefresh = null;
  }

  private upsertTarget(info: TargetInfo | undefined): boolean {
    if (!info || info.type !== 'page') return false;
    const previous = this.tabs.get(info.targetId);
    const next = {
      tabId: info.targetId,
      title: info.title ?? '',
      url: info.url ?? '',
      byAgent: previous?.byAgent ?? false,
      lastUsedAt: previous?.lastUsedAt ?? Date.now(),
    };
    if (previous && previous.title === next.title && previous.url === next.url) return false;
    this.tabs.set(info.targetId, next);
    this.activeTabId ??= info.targetId;
    return true;
  }

  private mostRecentTab(): string | null {
    let best: { id: string; at: number } | null = null;
    for (const tab of this.tabs.values()) if (!best || tab.lastUsedAt > best.at) best = { id: tab.tabId, at: tab.lastUsedAt };
    return best?.id ?? null;
  }

  // ── agent 那一侧(browser-agent-mcp.ts 经桥调)──────────────────────────────

  private async tabFor(sessionId: string): Promise<{ hub: CdpHub; targetId: string }> {
    const hub = await this.ensureHub();
    const owned = this.sessionTab.get(sessionId);
    if (owned && this.tabs.has(owned)) return { hub, targetId: owned };
    // Chrome 一起来自带的那张空白页没人用:第一条会话就用它,❌ 再开一张。
    const claimed = [...this.tabs.values()].find((tab) => !tab.byAgent && tab.url === 'about:blank' && ![...this.sessionTab.values()].includes(tab.tabId));
    let targetId = claimed?.tabId ?? null;
    if (!targetId) {
      // 各开一个窗口:有界面的 Chrome 只画每个窗口最前面那张页签,后台页签不出帧、截图会卡住。
      ({ targetId } = await hub.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', newWindow: true }));
    }
    this.sessionTab.set(sessionId, targetId);
    const tab = this.tabs.get(targetId);
    if (tab) tab.byAgent = true;
    else this.tabs.set(targetId, { tabId: targetId, title: '', url: 'about:blank', byAgent: true, lastUsedAt: Date.now() });
    this.activeTabId = targetId;
    this.notify();
    return { hub, targetId };
  }

  async openTransport(sessionId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { hub, targetId } = await this.tabFor(sessionId);
    signal?.throwIfAborted();
    return createCloudPageTransport(hub, targetId, {
      // 一步做到一半人接管:接管要等这一步做完才给(见 acquireControl),所以这里只挡「停止」之后还在发的命令。
      refuse: () => (this.automation === 'stopped' ? STOPPED_MESSAGE : null),
    });
  }

  private totalInFlight(): number {
    let total = 0;
    for (const count of this.inFlight.values()) total += count;
    return total;
  }

  toolStarting(sessionId: string): { ok: true } | { ok: false; message: string } {
    if (this.automation === 'stopped') return { ok: false, message: STOPPED_MESSAGE };
    if (this.holder || this.pendingHolder) return { ok: false, message: TAKEN_OVER_MESSAGE };
    this.inFlight.set(sessionId, (this.inFlight.get(sessionId) ?? 0) + 1);
    this.usedSince.add(sessionId);
    this.lastActivityAt = Date.now();
    this.completed = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const owned = this.sessionTab.get(sessionId);
    if (owned) {
      const tab = this.tabs.get(owned);
      if (tab) tab.lastUsedAt = Date.now();
      this.activeTabId = owned;
    }
    if (this.automation !== 'running') {
      this.automation = 'running';
      this.notify();
    }
    return { ok: true };
  }

  toolFinished(sessionId: string): void {
    const left = (this.inFlight.get(sessionId) ?? 1) - 1;
    if (left > 0) this.inFlight.set(sessionId, left);
    else this.inFlight.delete(sessionId);
    this.lastActivityAt = Date.now();
    void this.refreshTabs();
    if (this.totalInFlight() > 0) return;
    if (this.pendingHolder) {
      this.grant(this.pendingHolder);
      return;
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.totalInFlight() === 0 && this.automation === 'running') {
        this.automation = 'idle';
        this.notify();
      }
    }, DRIVING_IDLE_MS);
    this.idleTimer.unref?.();
  }

  async workspaceRoot(sessionId: string): Promise<string | null> {
    return (await agentSessionContext(sessionId))?.workspaceRoot ?? null;
  }

  /** 请人登录(密码保险箱)。返回给 agent 的那段话 —— 永远不含账号密码。 */
  async requestLogin(sessionId: string, args: { reason?: string }, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
    const gate = this.gate();
    if (gate) return { ok: false, message: gate };
    const owned = this.sessionTab.get(sessionId);
    const tab = owned ? this.tabs.get(owned) : undefined;
    const site = tab ? siteOf(tab.url) : null;
    if (!owned || !tab || !site) {
      return { ok: false, message: 'Open the site\'s login page in the browser first (browser_navigate), then call browser_request_login again.' };
    }
    let saved: Credential | null = null;
    try {
      saved = this.store.get(site);
    } catch (error) {
      // 存档解不开(密钥换了 / 文件坏了):当没存过,请人填 —— ❌ 每个站点的登录都跟着报错。
      log.warn('Cloud browser: could not read the saved logins', { error: String(error) });
    }
    const reuse = saved ?? this.recall(site);
    if (reuse) {
      const fill = await this.fill(owned, reuse);
      if (fill.username || fill.password) return { ok: true, message: filledMessage(site, fill, saved ? 'saved' : 'recent') };
    }
    const outcome = await this.waitForPerson(sessionId, { kind: 'login', site, url: tab.url, ...(args.reason ? { text: args.reason } : {}) }, signal);
    if (outcome.kind === 'filled') return { ok: true, message: filledMessage(site, outcome.fill, 'person') };
    return { ok: false, message: outcomeMessage(outcome, 'login') };
  }

  /** 请人接手一步(验证码、短信码、确认付款……):等人接管再交还。 */
  async requestTakeover(sessionId: string, args: { reason?: string }, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
    const gate = this.gate();
    if (gate) return { ok: false, message: gate };
    if (!this.sessionTab.has(sessionId)) return { ok: false, message: 'Open the page in the browser first (browser_navigate), then ask the person.' };
    const outcome = await this.waitForPerson(sessionId, { kind: 'takeover', ...(args.reason ? { text: args.reason } : {}) }, signal);
    if (outcome.kind === 'returned') {
      return { ok: true, message: 'The person did it and handed the browser back. Take a fresh browser_snapshot before you continue: the page may have changed.' };
    }
    return { ok: false, message: outcomeMessage(outcome, 'takeover') };
  }

  private gate(): string | null {
    if (this.automation === 'stopped') return STOPPED_MESSAGE;
    if (this.holder) return TAKEN_OVER_MESSAGE;
    return null;
  }

  private waitForPerson(
    sessionId: string,
    ask: { kind: 'login' | 'takeover'; site?: string; url?: string; text?: string },
    signal?: AbortSignal
  ): Promise<AssistanceOutcome> {
    // 同一时刻只挂一个求助;前一个还挂着(另一条会话的)就让它先照实收场。
    this.assistance?.settle({ kind: 'dismissed' });
    return new Promise<AssistanceOutcome>((resolve) => {
      const requestId = randomUUID();
      let done = false;
      const timer = setTimeout(() => settle({ kind: 'timeout' }), ASSISTANCE_WAIT_MS);
      timer.unref?.();
      const onAbort = () => settle({ kind: 'dismissed' });
      signal?.addEventListener('abort', onAbort, { once: true });
      const settle = (outcome: AssistanceOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (this.assistance?.requestId === requestId) this.assistance = null;
        this.notify();
        resolve(outcome);
      };
      this.assistance = { requestId, sessionId, ...ask, settle };
      this.notify();
    });
  }

  private recall(site: string): Credential | null {
    const entry = this.remembered.get(site);
    if (!entry) return null;
    if (Date.now() > entry.until) {
      this.remembered.delete(site);
      return null;
    }
    return entry.credential;
  }

  private async fill(targetId: string, credential: Credential): Promise<FillResult> {
    for (const variant of secretVariants(credential.password)) this.secrets.add(variant);
    const hub = await this.ensureHub();
    const { sessionId } = await hub.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    try {
      return await fillLogin(hub, sessionId, credential);
    } finally {
      void hub.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    }
  }

  // ── 人那一侧(live-server.ts 经 websocket 调)────────────────────────────────

  /** 人在保险箱里点「确认添加」。返回给保险箱的结果(失败的原因让人看得懂;❌ 回显密码)。 */
  async submitCredential(requestId: string, credential: Credential, save: boolean): Promise<{ ok: true } | { ok: false; reason: 'gone' | 'noForm' | 'saveFailed' }> {
    const pending = this.assistance;
    if (!pending || pending.requestId !== requestId || pending.kind !== 'login' || !pending.site) return { ok: false, reason: 'gone' };
    const targetId = this.sessionTab.get(pending.sessionId);
    if (!targetId) return { ok: false, reason: 'gone' };
    const fill = await this.fill(targetId, credential);
    if (!fill.username && !fill.password) return { ok: false, reason: 'noForm' };
    let saved = false;
    if (save) {
      try {
        this.store.save(pending.site, credential);
        saved = true;
      } catch (error) {
        log.warn('Cloud browser: saving the login failed', { site: pending.site, error: String(error) });
        this.remembered.set(pending.site, { credential, until: Date.now() + REMEMBER_UNSAVED_MS });
        pending.settle({ kind: 'filled', fill, saved: false });
        return { ok: false, reason: 'saveFailed' };
      }
    }
    if (!saved) this.remembered.set(pending.site, { credential, until: Date.now() + REMEMBER_UNSAVED_MS });
    pending.settle({ kind: 'filled', fill, saved });
    return { ok: true };
  }

  dismissAssistance(requestId: string): void {
    if (this.assistance?.requestId === requestId) this.assistance.settle({ kind: 'dismissed' });
  }

  /** 人「接管浏览器」。agent 正在做一步 = 先排着(pending),这一步做完就给。 */
  acquireControl(clientId: string): 'granted' | 'pending' | 'occupied' {
    if (this.holder === clientId) return 'granted';
    if (this.holder || (this.pendingHolder && this.pendingHolder !== clientId)) return 'occupied';
    if (this.totalInFlight() > 0) {
      this.pendingHolder = clientId;
      this.notify();
      return 'pending';
    }
    this.grant(clientId);
    return 'granted';
  }

  private grant(clientId: string): void {
    this.pendingHolder = null;
    this.holder = clientId;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.automation = this.automation === 'stopped' ? 'stopped' : 'idle';
    this.notify();
  }

  /**
   * 人「交还给 Agent」/ 取消申请 / 那个看的人断开了。交还前先读一遍各页签的密码框,人接管时自己敲的密码进脱敏名单
   * (agent 之后的页面快照会把密码框的值原样写出来);读完才放 agent 动。
   */
  releaseControl(clientId: string): Promise<void> {
    if (this.pendingHolder === clientId) this.pendingHolder = null;
    const hub = this.hub();
    if (this.holder !== clientId || !hub || this.tabs.size === 0) {
      this.finishRelease(clientId);
      return Promise.resolve();
    }
    return withTimeout(this.rememberTypedPasswords(hub), RELEASE_READ_MS)
      .catch((error: unknown) => log.warn('Cloud browser: could not read the password fields before handing back', { error: String(error) }))
      .then(() => this.finishRelease(clientId));
  }

  private finishRelease(clientId: string): void {
    if (this.holder === clientId) {
      this.holder = null;
      if (this.assistance?.kind === 'takeover') this.assistance.settle({ kind: 'returned' });
    }
    this.notify();
  }

  private async rememberTypedPasswords(hub: CdpHub): Promise<void> {
    for (const targetId of [...this.tabs.keys()]) {
      let sessionId: string | null = null;
      try {
        ({ sessionId } = await hub.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true }));
        for (const value of await readPasswordValues(hub, sessionId)) for (const variant of secretVariants(value)) this.secrets.add(variant);
      } catch (error) {
        log.warn('Cloud browser: could not read the password fields of a tab', { targetId, error: String(error) });
      } finally {
        if (sessionId) void hub.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
      }
    }
  }

  controlFor(clientId: string): 'released' | 'pending' | 'granted' | 'occupied' {
    if (this.holder === clientId) return 'granted';
    if (this.pendingHolder === clientId) return 'pending';
    if (this.holder || this.pendingHolder) return 'occupied';
    return 'released';
  }

  isHolder(clientId: string): boolean {
    return this.holder === clientId;
  }

  /** 人「停止任务」。 */
  stopAutomation(): void {
    this.automation = 'stopped';
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.assistance?.settle({ kind: 'stopped' });
    this.notify();
  }

  /** 人「允许 Agent 继续」。 */
  resumeAutomation(): void {
    if (this.automation !== 'stopped') return;
    this.automation = 'idle';
    this.notify();
  }

  /** 工具结果里出现的已填密码 → 圆点。 */
  redact(text: string): string {
    let out = text;
    // 长的先盖:一个密码是另一个的一段时,先盖短的会把长的剩个尾巴露出来。
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    return out;
  }

  markActive(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.lastUsedAt = Date.now();
    if (this.activeTabId !== tabId) {
      this.activeTabId = tabId;
      this.notify();
    }
  }

  tabList(): CloudBrowserTab[] {
    return [...this.tabs.values()].map(({ tabId, title, url, byAgent }) => ({ tabId, title, url, byAgent }));
  }

  hasTab(tabId: string): boolean {
    return this.tabs.has(tabId);
  }

  status(livePort: { port: number; token: string } | null): CloudBrowserStatus {
    const assistance = this.assistance;
    return {
      available: !!this.binary(),
      running: !!this.hub(),
      ...(this.endedReason && !this.hub() ? { ended: true } : {}),
      tabs: this.tabList(),
      activeTabId: this.activeTabId,
      automation: this.automation,
      completed: this.completed,
      controlled: !!this.holder || !!this.pendingHolder,
      lastActivityAt: this.lastActivityAt ? new Date(this.lastActivityAt).toISOString() : null,
      assistance: assistance
        ? { requestId: assistance.requestId, kind: assistance.kind, ...(assistance.site ? { site: assistance.site } : {}), ...(assistance.url ? { url: assistance.url } : {}), ...(assistance.text ? { text: assistance.text } : {}) }
        : null,
      live: livePort,
    };
  }
}

type TargetInfo = { targetId: string; type: string; title?: string; url?: string };

const REDACTED = '••••••';

/**
 * 一个密码在工具结果里可能长的样子:原文、JSON 字符串里的转义、网址编码,以及表单用 GET 提交时进网址的写法
 * (application/x-www-form-urlencoded:空格成 +,!'()*~ 也编码)。
 * 太短的(< 4)不收:一两个字符的「密码」会把结果里所有同样的字都盖掉。
 */
export function secretVariants(secret: string): string[] {
  if (secret.length < 4) return [];
  const uri = encodeURIComponent(secret);
  const form = uri.replace(/%20/g, '+').replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return [...new Set([secret, JSON.stringify(secret).slice(1, -1), uri, form])];
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function filledMessage(site: string, fill: FillResult, source: 'saved' | 'recent' | 'person'): string {
  const who =
    source === 'saved'
      ? `Filled the login the person saved for ${site}`
      : source === 'recent'
        ? `Filled the login the person entered for ${site} a moment ago`
        : `The person entered their login for ${site} and it was filled into the page`;
  const what = fill.username && fill.password ? 'username and password' : fill.password ? 'the password' : 'the username';
  const next = fill.password
    ? 'Now submit the form (click the login button) and check the result with browser_snapshot.'
    : 'This page only asks for the username first: submit it, and when the password page appears call browser_request_login again (it fills the password without asking the person again).';
  return `${who} (${what}). You never see the credentials and must not ask the person to type them in chat. ${next}`;
}

function outcomeMessage(outcome: AssistanceOutcome, kind: 'login' | 'takeover'): string {
  switch (outcome.kind) {
    case 'dismissed':
      return kind === 'login'
        ? 'The person closed the password vault without logging in. Do not ask for the password in chat; tell them you need them to log in and wait.'
        : 'The person declined to take over. Tell them what is needed and wait.';
    case 'stopped':
      return STOPPED_MESSAGE;
    case 'timeout':
      return 'The person did not respond within 10 minutes. Tell them what you need in chat and stop for now.';
    case 'ended':
      return `The browser closed (${outcome.reason}). The next browser action opens it again.`;
    default:
      return 'Nothing was done.';
  }
}

let instance: CloudBrowser | null = null;

/** 账号进程里那一个(只在咕咕 server 上建)。 */
export function cloudBrowser(): CloudBrowser {
  if (!instance) {
    const created = new CloudBrowser();
    instance = created;
    // Chrome 是这个进程拉起的子进程:进程走了它 ❌ 留下(下次起来资料夹被它锁着)。
    process.once('exit', () => created.shutdown());
  }
  return instance;
}

/** 测试换一个。 */
export function setCloudBrowserForTests(next: CloudBrowser | null): void {
  instance = next;
}

export function isCloudBrowserHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GUGU_SERVER_MODE === '1';
}

/** browser-agent-mcp.ts 用的那套动作(与桌面 agentBrowserBridge 同一个形状,多两个求助)。 */
export function cloudAgentBrowserBridge(): AgentBrowserBridgeShape {
  const browser = cloudBrowser();
  return {
    closeSession: (sessionId) => browser.closeSession(sessionId),
    openTransport: (sessionId, signal) => browser.openTransport(sessionId, signal),
    toolStarting: (sessionId) => browser.toolStarting(sessionId),
    toolFinished: (sessionId) => browser.toolFinished(sessionId),
    setInitialUrl: () => {},
    workspaceRoot: (sessionId) => browser.workspaceRoot(sessionId),
    requestLogin: (sessionId, args, signal) => browser.requestLogin(sessionId, args, signal),
    requestTakeover: (sessionId, args, signal) => browser.requestTakeover(sessionId, args, signal),
    redact: (text) => browser.redact(text),
  };
}
