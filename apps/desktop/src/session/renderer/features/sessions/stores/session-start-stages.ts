// 会话启动时由**宿主**等着的那一步(#6183)—— 宿主经 `sessionStartStageChannel` 报来,这里按会话记住。
//
// 启动路上没有墙钟,等待因此必须看得见:终端腿的加载态读它,把「正在启动会话…」换成
// 「正在检查 <引擎> 可执行文件 · 从几点开始 · 取消」;聊天面板在 worker 报出自己的步骤之前,
// 读它显示「正在下载 ACP 适配器」(#6394)。它只是宿主那句话的镜像,❌ 不自己推断阶段。
import { observable, runInAction } from 'mobx';
import { sessionStartStageChannel } from '@shared/core/sessions/sessionEvents';
import { events } from '@renderer/lib/ipc';

export type SessionStartStage = {
  stage: 'checking-executable' | 'preparing-adapter';
  executable: string;
  since: number;
};

const stages = observable.map<string, SessionStartStage>();
let installed = false;

/** 幂等。第一个读者装上订阅;订阅活到页面结束(事实本来就只在宿主那一侧发生一次)。 */
function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  events.on(sessionStartStageChannel, (event) => {
    runInAction(() => {
      if (event.stage && event.executable && event.since !== undefined) {
        stages.set(event.sessionId, {
          stage: event.stage,
          executable: event.executable,
          since: event.since,
        });
      } else {
        stages.delete(event.sessionId);
      }
    });
  });
}

export function sessionStartStage(sessionId: string | null): SessionStartStage | null {
  ensureInstalled();
  return sessionId ? (stages.get(sessionId) ?? null) : null;
}
