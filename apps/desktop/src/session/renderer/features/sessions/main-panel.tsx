import { OfflineSessionInput } from '@/components/chat/OfflineSessionInput';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, type ReactNode } from 'react';
import { rendererLogger } from '@/lib/log';
import {
  getSessionManagerStore,
  getSessionPageStore,
  sessionErrorMessage,
  sessionViewKind
} from '@renderer/features/sessions/stores/session-selectors';
import {
  useSessionViewContext,
  useWorkspaceViewModel
} from '@renderer/features/sessions/session-view-context';
import { sessionTabView } from './session-tab-registry';
import { SessionMainColumn } from './view/session-main-column';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { Button } from '@renderer/lib/ui/button';
import { leaveSessionView } from '@renderer/features/sessions/leave-session-view';
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import { cloudWakeFailureText } from '@renderer/features/remote-hosts/connection-status';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { useCloudComputerGate } from './use-cloud-computer-gate';
import { machineUnavailableLabel } from './machine-unavailable-label';
import { machineRegistry } from '@renderer/lib/machine-routing';

const spinnerLog = rendererLogger('sessionpage/loading-span');

/**
 * #5331 转圈那一段的秒表 —— **判据就是这个组件画不画 LoadingIndicator**。
 *
 * owner 的验收线是「点下去到转圈消失 ≤3 秒」,而主进程的账本最早也只从 `startSessionInternal`
 * 起算 —— 那已经是转圈快结束的地方。项目挂载 / 建任务 / 工作区 provision 三档全在它之前,
 * 主进程那边一个点都没有。仪表只能长在这里:它和用户看到的是同一个 `kind`,不会漂。
 *
 * ❌ 别把它挪到 store 或 selector 里:那两处会在没画任何东西的时候也跑,量出来的就不是
 *    「用户看着转圈等了多久」。
 */
function useLoadingSpanStopwatch(kind: string, projectId: string, sessionId: string): void {
  const span = useRef<{ startedAt: number; phases: Array<[string, number]>; lastAt: number } | null>(null);
  useEffect(() => {
    const spinning = kind === 'creating' || kind === 'project-mounting'
      || kind === 'provisioning' || kind === 'idle';
    const now = Date.now();
    if (spinning) {
      if (!span.current) span.current = { startedAt: now, phases: [], lastAt: now };
      const current = span.current;
      const previous = current.phases[current.phases.length - 1];
      if (!previous || previous[0] !== kind) {
        if (previous) previous[1] = now - current.lastAt;
        current.phases.push([kind, 0]);
        current.lastAt = now;
      }
      return;
    }
    const current = span.current;
    if (!current) return;
    span.current = null;
    const last = current.phases[current.phases.length - 1];
    if (last) last[1] = now - current.lastAt;
    // pino 风格:**先字段后消息**(rendererLogger 的签名逐字如此)。
    spinnerLog.info({
      projectId,
      sessionId,
      endedAs: kind,
      totalMs: now - current.startedAt,
      phases: Object.fromEntries(current.phases),
    }, 'loading span closed');
  }, [kind, projectId, sessionId]);
}


/**
 * 三档错误屏的出口（spec `session-always-openable`）。
 *
 * ⚠️ 这三屏此前**一颗按钮都没有** —— 只有两行红字。owner 2026-09-19:
 * 「任何 bug 都不应该让会话打不开」；一屏错误文案配零个动作，就是把人留在死胡同里，
 * 与「只给一句错误」是同一件事（#5553 那张票的原话）。
 *
 * 出口按「这件事还能不能重来」分：
 *   · 工作区没准备好 ⇒ 重来（provisionSession 自己有在途去重，点多次不会叠）；
 *   · 任务没建成 / 拆不掉 ⇒ 重来无意义，出口是**回到项目**，❌ 不摆一颗注定失败的重试。
 */
function SessionErrorScreen({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string | undefined;
  action: { label: string; run: () => void };
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-8">
      <div className="flex max-w-xs flex-col items-center gap-2 text-center">
        <p className="font-sans text-sm font-medium text-foreground-destructive">{title}</p>
        <p className="font-sans text-xs text-foreground-muted">{detail}</p>
        <Button variant="outline" size="sm" className="mt-1" onClick={action.run}>
          {action.label}
        </Button>
      </div>
    </div>
  );
}

export const SessionMainPanel = observer(function SessionMainPanel() {
  const { projectId, sessionId } = useSessionViewContext();
  const kind = sessionViewKind(getSessionPageStore(projectId, sessionId), projectId);
  useLoadingSpanStopwatch(kind, projectId, sessionId);
  return (
    <SessionContentGate>
      <ReadySessionMainPanel />
    </SessionContentGate>
  );
});

/**
 * 会话的内容(页签、终端、文件、对话)只在会话 ready 时画:它们读工作区,而工作区只在 ready 时在
 * (`useWorkspaceId` 等读不到就抛)。没 ready 的每一档在这里换成它自己那一屏 —— 正在准备、出错、正在唤醒。
 *
 * **每个画会话内容的地方都经过这一道**:会话页(上面的 SessionMainPanel)、单独成窗的页签(WindowTabPane)。
 * 会话离开 ready 不只发生在打开之前:闲置回收把它挂起成「没准备」时,它的页签还开着。❌ 哪个界面绕过这一道
 * 直接画 PaneContent:那一刻它拿着一条没有工作区的会话去画内容,错误冒到应用根上,整个应用崩成「出现问题」
 * (2026-10-22 owner 实测:页签开在新窗口里审阅,会话被回收,「useWorkspaceId: session has no workspace」)。
 */
export const SessionContentGate = observer(function SessionContentGate({ children }: { children: ReactNode }) {
  const { translate } = useSessionMessages();
  const { projectId, sessionId } = useSessionViewContext();
  const sessionPageStore = getSessionPageStore(projectId, sessionId);
  const kind = sessionViewKind(sessionPageStore, projectId);
  // 要画这条会话、它的项目还没挂:挂上(别的机器上的项目只在用到时挂;那台机器没连上就等它连上)。
  useEffect(() => {
    if (kind !== 'project-mounting') return;
    void getProjectManagerStore().ensureMounted(projectId).catch(() => {});
  }, [kind, projectId]);
  const cloud = useCloudComputerGate(projectId, sessionId, kind);
  // 别的机器上的会话、那台此刻够不着(离线 / 开机恢复时线刚通又断):说它离线,❌ 一直转「正在准备文件」或摆一块
  // 「准备失败」。线通了由 view.tsx 那一处照常准备(准备只有那一个入口)。
  const unreachable = machineUnavailableLabel(projectId);
  const deviceId = machineRegistry.machineOf(projectId);
  const device = deviceId ? remoteHostsStore.device(deviceId) : null;
  const tunnelProgress = device?.tunnel === 'connecting' && !device.directTerminal
    ? translate('remoteWorkspace.tunnel.connecting') : null;

  if (kind === 'creating') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center text-foreground-muted">
        <LoadingIndicator
          ariaLabel={translate('task.creatingTask')}
          label={translate('task.creatingTask')}
        />
      </div>
    );
  }

  if (kind === 'create-error') {
    // 任务本身没建成 ⇒ 没有可重来的东西，出口是回到项目。
    return (
      <SessionErrorScreen
        title={translate('task.createTaskFailed')}
        detail={sessionErrorMessage(sessionPageStore, translate)}
        action={{
          label: translate('task.backToProject'),
          run: () => leaveSessionView(projectId, sessionId),
        }}
      />
    );
  }

  // #7199 这条会话在一台没醒着的云电脑上:先说「正在唤醒」等它醒(打开会话那一下已叫醒它),❌ 先去准备文件、连不上就报失败。
  if (cloud && (kind === 'project-mounting' || kind === 'provisioning' || kind === 'idle' || kind === 'provision-error' || kind === 'project-error')) {
    if (cloud.failure) {
      return (
        <SessionErrorScreen
          title={translate('remoteHost.status.wakeFailed', { device: cloud.label })}
          detail={cloudWakeFailureText(cloud.failure, cloud.label, translate)}
          action={{ label: translate('common.retry'), run: () => void remoteHostsStore.wakeCloudComputer(cloud.deviceId) }}
        />
      );
    }
    return (
      <div className="flex h-full w-full flex-col items-center justify-center text-foreground-muted">
        <LoadingIndicator ariaLabel={translate('remoteHost.status.waking', { device: cloud.label })} label={translate('remoteHost.status.waking', { device: cloud.label })} />
      </div>
    );
  }

  if (unreachable && (kind === 'project-mounting' || kind === 'provisioning' || kind === 'idle' || kind === 'provision-error' || kind === 'project-error')) {
    return deviceId ? <OfflineSessionInput deviceId={deviceId} sessionId={sessionId} label={unreachable} />
      : <div className="flex h-full w-full items-center justify-center text-sm text-foreground-muted">{unreachable}</div>;
  }

  if (kind === 'project-mounting' || kind === 'provisioning') {
    // provisionProgressMessage 是主进程推来的实时进度原文，原样显示；缺省时才落到本地化外壳。
    const progressMessage =
      tunnelProgress ?? sessionPageStore?.provisionProgressMessage ?? translate('task.settingUpWorkspace');
    return (
      <div className="flex h-full w-full flex-col items-center justify-center text-foreground-muted">
        <LoadingIndicator ariaLabel={translate('task.settingUpWorkspace')} label={progressMessage} />
      </div>
    );
  }

  if (kind === 'provision-error' || kind === 'project-error') {
    // 两档都可以重来，但**重来的对象不是同一个**：
    //   · provision-error —— 项目挂上了、工作区没准备好 ⇒ 重跑 provisionSession（自带在途去重）。
    //   · project-error   —— 项目**本身**没挂上（`isUnmountedProject`），那时
    //     `getSessionManagerStore` 读的 `mountedProject.sessionManager` 必然 undefined，
    //     可选链把调用整个吞掉 ⇒ 点了什么都不发生。这比摆一颗会失败的按钮更坏，因为它连
    //     失败都不报。⇒ 这一档重挂**项目**。
    const retryRun =
      kind === 'project-error'
        ? () => {
            void getProjectManagerStore().mountProject(projectId).catch(() => {});
          }
        : () => {
            void getSessionManagerStore(projectId)?.provisionSession(sessionId).catch(() => {});
          };
    return (
      <SessionErrorScreen
        title={translate('task.setUpWorkspaceFailed')}
        detail={sessionErrorMessage(sessionPageStore, translate)}
        action={{ label: translate('common.retry'), run: retryRun }}
      />
    );
  }

  if (kind === 'idle') {
    // provisionProgressMessage 是主进程推来的实时进度原文，原样显示；缺省时才落到本地化外壳。
    const progressMessage =
      tunnelProgress ?? sessionPageStore?.provisionProgressMessage ?? translate('task.settingUpWorkspace');
    return (
      <div className="flex h-full w-full flex-col items-center justify-center text-foreground-muted">
        <LoadingIndicator ariaLabel={translate('task.settingUpWorkspace')} label={progressMessage} />
      </div>
    );
  }

  // 归档掉的 task 不是一个能停留的地方,所以这里**不画任何东西**:既不画「正在准备文件…」(那是把
  // 一个静止状态说成正在加载,正是本次的 bug),也不写一句「这项任务已归档」的产品文案 —— 给一个
  // 按设计不该抵达的状态配 UI,等于把「我们漏了一条路」化装成正常产品状态,下次再漏就更难发现。
  // 该做的是走人:view.tsx 的自愈那一步会把人送回项目页,并在日志里留下「怎么会到这儿」。
  // 这一档存在的唯一理由是把它从 'idle' 里摘出来 —— 落回 idle 会被自动 provision 反向复活。
  if (kind === 'archived' || kind === 'missing') {
    return null;
  }

  return children;
});

const ReadySessionMainPanel = observer(function ReadySessionMainPanel() {
  const sessionView = useWorkspaceViewModel();

  return (
    <sessionTabView.TabLayoutProvider layout={sessionView.paneLayout}>
      <SessionMainColumn />
    </sessionTabView.TabLayoutProvider>
  );
});
