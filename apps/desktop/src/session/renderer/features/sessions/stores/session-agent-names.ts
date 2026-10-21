import { makeAutoObservable, runInAction } from 'mobx';
import {
  findSessionShellPort,
  isSessionShellUnsupported,
  onSessionpageIdentityEvent,
} from '@renderer/lib/shell-port';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { subscribeDeviceSessions } from '@/session/shared/remote-sessions/session-directory';
import { readIdentityDirectoryBridge, type IdentityDirectoryBridge } from '@/lib/identityDirectoryBridge';
import { agentNamesFromPeers, type SessionShellAgentName } from '@shared/lib/ipc/shell-port';
import { log } from '@renderer/utils/logger';

/** 一条会话背后的咕咕身份:名字 + agent id。两格同源(本机花名册同一行),❌ 拆成两张表各自过期。 */
export interface SessionAgentIdentity {
  displayName: string;
  agentUserId: string;
}

/** 这张表从哪里读、听什么(默认接壳口;单测换成假的)。 */
export interface SessionAgentNamesSource {
  /** 本机那一份;null = 没有壳(SSR / 测试),表留空。 */
  readAll(): Promise<SessionShellAgentName[]> | null;
  /** 别的机器上的:会话目录里带 agent id 的行,名字按 id 从身份缓存取(❌ 逐台去问)。 */
  readRemote(): SessionShellAgentName[];
  /** 会话目录变了(哪台机器的列表到了 / 变了)。 */
  onRemoteChange(cb: () => void): () => void;
  /** 开户 / 改名事件(本机与每台机器合流)。 */
  onIdentityEvent(cb: (event: SessionShellAgentName) => void): () => void;
  directory(): IdentityDirectoryBridge | null | undefined;
}

const shellSource: SessionAgentNamesSource = {
  readAll: () => findSessionShellPort()?.agentNames() ?? null,
  readRemote: () => agentNamesFromPeers(remoteHostsStore.directoryPeers().peers),
  onRemoteChange: subscribeDeviceSessions,
  onIdentityEvent: onSessionpageIdentityEvent,
  directory: () => readIdentityDirectoryBridge(),
};

/**
 * 「侧栏这一行背后是哪个 agent」——`Claude 3`、`Codex 8`(#5818),以及它的 agent id(#6092)。
 *
 * 行上写的是会话标题(第一条提示词推出来的那句话),它回答不了「谁是谁」;而这个问题在一屏十几行、
 * 指针一路划过去的时候每一行都要被问一次。所以这里把答案放成**一张表**:
 *
 *  · agent id 由本机绑定索引给出,名字由壳口从 `identity.users.display_name` 读出,与通讯录 / 分享名片 /
 *    @ 弹层同一个事实(壳口 `agentNames`,与分享按钮的 `agentCard` 读同一格),❌ 不在渲染层另造一个名字。
 *  · 启动时整份读一次,之后靠 `sessionpage-agent-provisioned` / `sessionpage-agent-renamed` 两条**既有**事件
 *    增量更新 —— ❌ 轮询,❌ 每行各查一次(那会把整份名册读十几遍)。
 *  · #6264 别的机器上的会话:会话目录的行上带着 agent id,名字按 id 从身份缓存取;目录或身份缓存一变就再收一遍。
 *    那台机器推的两条事件照样合流。❌ 逐台机器去问 —— 掉线又回来的那台会让读的人等到超时(#7016)。
 *  · 查不到就是**没有**:那条会话还没有咕咕身份(从没起过、或这家引擎不可寻址)。调用方据此把身份卡上
 *    agent 那两行写成「未分配」,❌ 不拿标题冒充人名。
 */
export class SessionAgentNames {
  /** conversationId → 身份。不在表里 = 这条会话还没有身份。 */
  identities = new Map<string, SessionAgentIdentity>();
  /** 整份读过一次了吗。没读过与「读过、这条没有」在界面上是同一副样子,所以单独记一格备诊断。 */
  isLoaded = false;
  private started = false;

  constructor(private readonly source: SessionAgentNamesSource = shellSource) {
    makeAutoObservable<SessionAgentNames, 'source'>(this, { source: false });
  }

  nameFor(sessionId: string): string | undefined {
    return this.identities.get(sessionId)?.displayName;
  }

  identityFor(sessionId: string): SessionAgentIdentity | undefined {
    return this.identities.get(sessionId);
  }

  /** 单条落表:两条事件的载荷同形,所以共用这一个入口。名字或 id 缺一格都不入表(见类注释)。 */
  note(sessionId: string, displayName: string, agentUserId: string): void {
    const id = sessionId.trim();
    const name = displayName.trim();
    const agent = agentUserId.trim();
    if (!id || !name || !agent) return;
    runInAction(() => {
      this.identities.set(id, { displayName: name, agentUserId: agent });
    });
  }

  /**
   * 整份读一次。没有壳(SSR / 测试)或这个形态的壳不答这一口 → 表留空,侧栏就只是不画身份。
   * ❌ 不抛:一层「顺手告诉你这行是谁」的提示,不该把侧栏或启动流程带下去。
   */
  async load(): Promise<void> {
    const reading = this.source.readAll();
    if (!reading) return;
    try {
      this.adoptRows(await reading);
      runInAction(() => {
        this.isLoaded = true;
      });
    } catch (error) {
      if (isSessionShellUnsupported(error)) return;
      log.warn('[sessionpage] 读会话身份表失败,侧栏这一轮不显示 agent 身份', { error });
    }
  }

  private adoptRows(rows: readonly SessionShellAgentName[]): void {
    runInAction(() => {
      for (const row of rows) {
        this.identities.set(row.conversationId, { displayName: row.displayName, agentUserId: row.agentUserId });
      }
    });
  }

  /** Keep the session-page cache aligned when the shared cloud identity directory receives a rename. */
  private syncCanonicalNames(): void {
    const identities = this.source.directory()?.getSnapshot();
    if (!identities) return;
    runInAction(() => {
      for (const identity of this.identities.values()) {
        const canonical = identities[identity.agentUserId]?.display_name?.trim();
        if (canonical && canonical !== identity.displayName) identity.displayName = canonical;
      }
    });
  }

  /**
   * 接上两条事件并整份读一次。**幂等**:侧栏收起再展开会重新挂载,再点一次不该重订阅、也不该
   * 再把名册读一遍。订阅跟着应用活一辈子,所以不给退订 —— 这张表本身也是全应用一份。
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.source.onIdentityEvent((event) => this.note(event.conversationId, event.displayName, event.agentUserId));
    this.source.onRemoteChange(() => this.adoptRows(this.source.readRemote()));
    // Contacts/chat publish the same identity.users snapshot through this bridge. Subscribe to its
    // updates so a rename received from another device cannot leave the session-page card on an old name
    // (and so a remote row whose name was still being fetched gets it).
    this.source.directory()?.subscribe(() => {
      this.syncCanonicalNames();
      this.adoptRows(this.source.readRemote());
    });
    this.adoptRows(this.source.readRemote());
    void this.load();
  }
}

export const sessionAgentNames = new SessionAgentNames();
