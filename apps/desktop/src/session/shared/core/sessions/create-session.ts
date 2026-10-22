import type { Session } from '@shared/core/sessions/sessions';
import type { NewSessionConfig } from '@shared/core/sessions/new-session-config';
import type { WorkspaceConfig } from '@shared/core/workspaces/workspace-config';

export type SessionBootstrapStatus =
  | { status: 'ready' }
  | { status: 'bootstrapping' }
  | { status: 'error'; message: string }
  | { status: 'not-started' };

/**
 * 新建一条会话。会话的 id 就是 `sessionConfig.initialSession.id`:建会话一定带着它的首轮会话,
 * 不存在「先有一个空壳、再往里放会话」。
 */
export type CreateSessionParams = {
  projectId: string;
  /** Typed, versioned creation payload (title, issue link, the conversation to start). */
  sessionConfig: NewSessionConfig;
  /** Typed, versioned workspace configuration (git setup + workspace location). */
  workspaceConfig: WorkspaceConfig;
  /** Set when an automation run creates the session; kept on the session row. */
  automationRunId?: string;
  /** The group it is born in (「在群里新建 Agent」): its identity joins it when first minted, as `session_spawn`'s `chat_id`. */
  birthGroup?: BirthGroup;
};

/**
 * The group an agent is born in, and how it takes its seat there. A task agent (a new task from a chat, a child an agent
 * spawns into a chat) sits passive and joins without a join notice, like a task agent in a project group; an agent pulled
 * in on purpose (「新建 Agent」 from a group's members, an App's agent) joins active, with the notice.
 */
export type BirthGroup = { chatId: string; asTask: boolean };

export type CreateSessionError =
  | { type: 'project-not-found' }
  /**
   * @@@5173 引擎此刻起不来,所以这条任务**没有被创建** —— 库里一行都没写。
   * `reason` 决定指路:`updating` = 正在被替换,自己会好,让用户稍后重试;
   * `missing` = 真没装,给安装引导。两者指向相反的方向,❌ 别合成一种。
   */
  | {
      type: 'harness-unavailable';
      reason: 'updating' | 'missing';
      providerId: string;
      harnessName: string;
      /** 解析器自己的诊断原文(查过的位置),逐字保留、永不翻译。 */
      detail: string;
    }
  | { type: 'provision-failed'; message: string }
  | { type: 'provision-timeout'; timeoutMs: number; step?: string };

export type CreateSessionSuccess = {
  session: Session;
};

export type ProvisionSessionResult = {
  path: string;
  workspaceId: string;
};

export type ProvisionWorkspaceError =
  | { type: 'no-intent' }
  | { type: 'missing-workspace' }
  | { type: 'setup-failed'; stepKind: string; stepErrorType: string; message?: string };
