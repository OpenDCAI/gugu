import type { GuguPermissionMode } from '@gugu/session-core/acp';
import { type Session, type SessionMessage } from '@shared/core/sessions/sessions';

export interface SessionProvider {
  startSession(
    session: Session,
    initialSize?: { cols: number; rows: number },
    isResuming?: boolean,
    initialPrompt?: string,
    /** spec session-fork-share: source provider session id, passed only to the initial
     * fork spawn. Later spawns resume the forked child session. */
    forkFromProviderSessionId?: string
  ): Promise<void>;
  /** Accept an exact ordinary-message command; not-ready proves that no bytes were accepted. */
  sendMessage?(
    session: Session,
    message: SessionMessage,
  ): Promise<{ status: 'not-ready' } | { status: 'accepted'; messageId: string }>;
  detachSession(sessionId: string): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  /**
   * 这条会话的运行时归不归我管 —— 在跑,**或者还在起**(#6183)。
   * 停止要问的就是这个事实:起的那一段还没有 PTY 注册,按 PTY 注册表去猜「是不是会话」会把一次
   * 正在起的会话当成普通终端,「取消」于是什么都没做(真机实测:版本探针卡住,点取消 60s 无反应)。
   */
  ownsSession(sessionId: string): boolean;
  destroyAll(): Promise<void>;
  detachAll(): Promise<void>;
}

export type SessionConfig = {
  /** 咕咕的权限档;缺席(导入的会话)按编辑档(`resolveSessionPermissionMode`)。 */
  permissionMode?: GuguPermissionMode;
  /** Provider-native session id (e.g. Codex rollout UUID) used when resuming. */
  providerSessionId?: string;
};
