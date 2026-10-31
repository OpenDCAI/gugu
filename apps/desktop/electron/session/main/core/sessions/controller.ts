import { createRPCController } from '@shared/lib/ipc/rpc';
import { archiveSession, restoreSession } from './archiveSession';
import { dehydrateSession } from './dehydrateSession';
import { getSessions } from './getSessions';
import { getSessionsForProject } from './getSessionsForProject';
import { getUnarchivedSession } from './getUnarchivedSession';
import { convertAutomationSession } from './convert-automation-session';
import { forkSession } from './fork-session';
import { getStoredHistory, getStoredToolImage } from './session-turn-store';
import { syncStoredHistoryFromRecord } from './record-backfill';
import { hydrateSession } from './hydrateSession';
import { markSessionSeen } from './markSessionSeen';
import { renameSession } from './renameSession';
import { restartSession } from './restart-session';
import { setSessionPinned } from './setSessionPinned';
import { setSessionParent } from './session-family';
import { switchSessionRuntime } from './switch-session-runtime';
import { sendMessage } from './sendMessage';
import { ensurePlatformSessionReady } from './platform-recovery-gate';
import { recordLiveSessionSetting } from './record-live-session-setting';
import { recordLiveModelSwitch } from './live-model-switch';
import { getRuntimeUpgradeRequirement, startupFailureForUser } from './spawn-failure';
import { setSessionsOnScreen } from './sessions-on-screen';

/**
 * ❌ 这里**没有** createConversation —— 对外只有一个创建动词 `sessionCreate.createSession`
 * (spec session-resume:新建会话必须带首轮)。「在已有工作区里再起一条会话」是内部动作
 * (attachAgentToSession),只服务 fork / 派活 / 侧边会话,不上这张面:堵洞靠「够不着」,
 * 而不是靠再加一道拦。
 *
 * 留在面上的三个动词各自能表达的东西都很窄:分叉/侧边会话只能说「照抄哪条会话」,
 * 重来只能说「哪条会话重开」—— 没有一个能拿来造出一条凭空的、没有首轮的会话。
 */
export const sessionController = createRPCController({
  getSessions,
  getStoredHistory,
  getStoredToolImage,
  // #980 打开一条没在跑的会话时:把 agent 自己的记录里有、库里还没有的那几轮补进库,回补进了几轮。
  syncStoredHistoryFromRecord,
  forkSession,
  restartSession,
  switchSessionRuntime,
  // 人手动收起与自动清理共用归档;任务历史与绑定保留。
  archiveSession,
  // spec session-graph:UI 上没有恢复入口(owner 2026-09-11),但接口在 —— 归档不是删除,
  // 「数据回得来」这件事必须有代码作证。摆不摆入口是另一个决定。
  restoreSession,
  // #7103 起任务失败到界面之前按层分:咕咕这一侧的只交原因码,harness 自己说的照原话(startupFailureForUser)。
  hydrateSession: (projectId: string, sessionId: string) =>
    hydrateSession(projectId, sessionId).catch((error: unknown) => {
      throw startupFailureForUser(error);
    }),
  dehydrateSession,
  renameSession,
  setSessionPinned,
  // 人在侧栏把一条会话拖到另一条上 = 挂到它下面:与 agent 的 `session_set_parent` 同一个动作(校验、落库、事件都在
  // setSessionParent 里)。同样在 child 所在的机器上做 —— agent 那边由宿主按 child 的地址转,人这边由会话页按 child 的机器选线。
  setSessionParent,
  convertAutomationSession,
  getUnarchivedSession,
  getSessionsForProject,
  markSessionSeen,
  sendMessage,
  ensurePlatformSessionReady,
  recordLiveSessionSetting,
  recordLiveModelSwitch,
  // #6341 hydrate 被拒之后,renderer 按会话 id 取「是不是 harness 版本太低」—— 有就给出升级出口。
  getRuntimeUpgradeRequirement,
  // 屏上的会话由渲染层报(主进程看不见界面),闲置回收据此不停人正看着的会话(renderer/app/sessions-on-screen.ts)。
  reportSessionsOnScreen: async (sessionIds: string[]) => {
    setSessionsOnScreen(sessionIds);
  },
});
