// gugu #2549: composer-only root for 对话页原地创建 Agent. App.tsx renders this instead of the full
// Workspace when the host (gugu MainLayout) reactively switches embedView to 'composer' on the SAME
// persistent embed instance the session page uses — see lib/stores/embed-view.ts for why this must stay
// one instance rather than a second independent module load.
//
// Reuses NewSessionComposer (new-session-page.tsx), including its createSession submission. This root supplies
// NewSessionPage's implicit-project effect and shared title; DraftWorkspacePanel's terminal/browser/files
// side panel remains session-page-specific.
//
// gugu #2525: 它另外挂上共享创建器的「创建上下文」托盘（设备 · 项目）。设备维度与 per-user 的
// 「记住最近一次选择」都在 gugu 侧（identity.gugu_devices + identity.user_settings），经
// window.__GUGU_CREATE_CONTEXT__ 送进来 —— 契约的权威定义在 gugu 的
// apps/desktop/src/lib/agentCreateContextBridge.ts，下面的接口是它跨 bundle 的结构性副本
// （与既有 window 跨 bundle 适配边界同一种两侧各声明一份的做法）。
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ComposerBirthGroupChip, ComposerProjectPicker, mountedProjects } from '@renderer/features/sessions/composer-context-tray';
import { MachinePicker } from '@renderer/features/remote-hosts/machine-picker';
import type { MachineChoice } from '@renderer/features/remote-hosts/machine-choice';
import { ensureImplicitSessionHomeProjectId } from '@renderer/features/sessions/implicit-session-home-project';
import { NewSessionComposer } from '@renderer/features/sessions/new-session-page';
import {
  isProjectPathConflictError,
  projectPathConflictMessage,
} from '@renderer/features/projects/stores/project-creation-error';
import { ShellTitlebarDragRegion } from '@renderer/lib/components/titlebar/shell-titlebar';
import {
  sessionComposerFrameLiftClassName,
  sessionComposerDockBandClassName,
  sessionComposerDockedWidthClassName,
  sessionComposerTrayClassName,
  sessionComposerTrayStyle
} from '@renderer/features/sessions/session-composer-styles';
import { SessionShellProvider } from '@renderer/features/sessions/session-shell-context';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { LibraryHostProvider, machineLibraryHost } from '@renderer/features/library/library-host';
import { machineComposerProps, useComposerMachines } from '@renderer/features/sessions/use-machine-create-target';
import { log } from '@renderer/utils/logger';

interface CreateContextSnapshot {
  ready: boolean;
  devices: MachineChoice[];
  selectedDeviceId: string | null;
  selectedProjectId: string | null;
  projectsAvailable: boolean;
  blockMessage: string | null;
  /** 群成员里点的「新建 Agent」:建出来的 agent 一出生就进这个群。null = 不进群。 */
  birthGroup: { chatId: string; name: string } | null;
}

interface CreateContextBridge {
  getSnapshot(): CreateContextSnapshot;
  subscribe(listener: () => void): () => void;
  selectDevice(deviceId: string): void;
  selectProject(projectId: string | null): void;
  reportAvailableProjects(projectIds: string[]): void;
}

const PENDING_SNAPSHOT: CreateContextSnapshot = {
  ready: false,
  devices: [],
  selectedDeviceId: null,
  selectedProjectId: null,
  projectsAvailable: false,
  blockMessage: null,
  birthGroup: null
};

function readBridge(): CreateContextBridge | undefined {
  return (window as unknown as { __GUGU_CREATE_CONTEXT__?: CreateContextBridge })
    .__GUGU_CREATE_CONTEXT__;
}

/** 宿主的桥在同一个 document 里、由 gugu 的 MainLayout 装载，但两边的挂载时序不保证；桥还没到就
 *  短轮询等它，而不是把「暂时没有」误判成「没有创建上下文」。等超了就 fail loud —— 一个读不到
 *  创建上下文的 composer 必须说出来并挡住提交，❌ 不许退化成"没有设备维度"照常发送。 */
const BRIDGE_WAIT_MS = 10_000;

function useCreateContext(): {
  snapshot: CreateContextSnapshot;
  bridge: CreateContextBridge | undefined;
  missing: boolean;
} {
  const [bridge, setBridge] = useState<CreateContextBridge | undefined>(readBridge);
  const [missing, setMissing] = useState(false);
  const [snapshot, setSnapshot] = useState<CreateContextSnapshot>(
    () => readBridge()?.getSnapshot() ?? PENDING_SNAPSHOT
  );

  useEffect(() => {
    let disposed = false;
    let waited = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const attach = () => {
      if (disposed) return;
      const found = readBridge();
      if (!found) {
        waited += 100;
        if (waited >= BRIDGE_WAIT_MS) {
          setMissing(true);
          return;
        }
        timer = setTimeout(attach, 100);
        return;
      }
      setMissing(false);
      setBridge(found);
      setSnapshot(found.getSnapshot());
      unsubscribe = found.subscribe(() => setSnapshot(found.getSnapshot()));
    };
    attach();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
  }, []);

  return { snapshot, bridge, missing };
}

export const ComposerEmbedRoot = observer(function ComposerEmbedRoot() {
  // Mirrors NewSessionPage's own implicit-project effect: 未选择项目 is a real first-class state that
  // runs in the hidden app-owned execution context — without it selectedProjectId stays undefined
  // forever and NewSessionComposer's canCreate never flips.
  const [implicitProjectId, setImplicitProjectId] = useState<string | undefined>(undefined);
  const { translate } = useSessionMessages();
  const [projectError, setProjectError] = useState<string | null>(null);
  const { snapshot, bridge, missing } = useCreateContext();

  useEffect(() => {
    let cancelled = false;
    void ensureImplicitSessionHomeProjectId()
      .then((id) => {
        if (cancelled) return;
        if (!id) {
          setProjectError(translate('newAgent.workspaceFailed'));
          return;
        }
        setImplicitProjectId(id);
        setProjectError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // 原始诊断只进日志；已知的 path conflict 在边界映射成可操作、且不含绝对路径的文案。
        log.error('[composer-embed] 准备默认任务工作区失败', error);
        setProjectError(
          isProjectPathConflictError(error)
            ? projectPathConflictMessage(error, translate)
            : translate('newAgent.workspaceFailed')
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 「项目列表只展示所选设备可用的项目」——这份列表只有会话页知道，所以上报给宿主，让记忆的
  // 命中判定留在唯一那份规则里（gugu core 的 resolveAgentCreateProject），❌ 不在这边再写一遍。
  const availableProjectIds = mountedProjects().map((p) => p.id);
  // 列表每次 render 都是新数组，不能直接当依赖；用内容摘要当依赖、真值走 ref。
  const availableIdsRef = useRef<string[]>(availableProjectIds);
  availableIdsRef.current = availableProjectIds;
  const availableKey = availableProjectIds.join('|');
  useEffect(() => {
    bridge?.reportAvailableProjects(availableIdsRef.current);
  }, [bridge, availableKey]);

  const selectProject = useCallback(
    (projectId: string | undefined) => bridge?.selectProject(projectId ?? null),
    [bridge]
  );
  const selectDevice = useCallback(
    (deviceId: string) => bridge?.selectDevice(deviceId),
    [bridge]
  );

  const effectiveProjectId = snapshot.selectedProjectId ?? implicitProjectId;
  // #6264 所选机器是另一台:同一个创建框、同一套发送,项目是那台机器项目表里的项目(或它的隐藏工作区),
  // 数据问那台机器、会话建在那台机器上(rpc 按项目所在机器路由)。宿主记着的是那台机器上的目录路径。
  const { machines, machineContext, projectPicker } = useComposerMachines(
    snapshot.devices,
    snapshot.selectedDeviceId,
    snapshot.selectedProjectId,
    <ComposerProjectPicker
      selectedId={snapshot.selectedProjectId ?? undefined}
      onSelect={selectProject}
      unavailableHint={
        snapshot.ready && !snapshot.projectsAvailable ? translate('newAgent.projectsUnavailable') : null
      }
    />,
    (path) => {
      if (path) bridge?.reportAvailableProjects([path]);
      bridge?.selectProject(path);
    }
  );
  const isContextPending = !missing && !snapshot.ready;
  const blockReason = missing
    ? translate('newAgent.contextUnavailable')
    : snapshot.blockMessage;

  return (
    <SessionShellProvider>
      <div className="relative z-40 h-0">
        <ShellTitlebarDragRegion />
      </div>
      {/* @@@create-draft-anchor (#2525) — 这是「对话页原地创建」草稿态的**唯一根锚点**。
          #2558 把对话列表「新建 Agent」的目的地从 CreateAgentModal 改成了这个 composer,
          但没留任何 data-testid,于是共享 helper createAgentViaHome 只能继续等旧模态、超时,
          所有用它的 spec 一起红(见 #2525)。锚点在此,驱动按它断言「草稿真的开了」,
          ❌ 不要靠 class 名或文案定位——那些会随样式/文案漂。
          宿主帧是 open shadow root(EmdashSessionFrame attachShadow mode:'open'),
          Playwright 的 CSS 定位器可穿透,page.locator 直接够得到。 */}
      <div
        data-testid="agent-create-draft"
        data-create-context-ready={snapshot.ready ? 'true' : 'false'}
        className="flex h-full min-h-0 flex-col"
      >
        <div className="flex min-h-0 flex-1 items-center justify-center px-4">
          <h1 className="gg-type-page-title">
            {translate('newAgent.title')}
          </h1>
        </div>
        <div className={sessionComposerDockBandClassName}>
          <div className={sessionComposerDockedWidthClassName}>
            {/* 通栏上下文托盘:设备 · 项目。与会话页同一条托盘、同一套控件(composer-context-tray)。 */}
            <div className={sessionComposerTrayClassName} style={sessionComposerTrayStyle}>
              <MachinePicker
                size="compact"
                testId="composer-device-picker"
                wakeOnPick="retry"
                machines={machines}
                selectedId={snapshot.selectedDeviceId}
                onSelect={selectDevice}
              />
              {projectPicker}
              {snapshot.birthGroup ? (
                <ComposerBirthGroupChip name={snapshot.birthGroup.name} />
              ) : null}
            </div>
            <div className={sessionComposerFrameLiftClassName}>
              <LibraryHostProvider value={machineContext?.host ?? machineLibraryHost(null)}>
                <NewSessionComposer
                  // 换机器 = 换一个创建目标:整棵重挂,上一台机器的选择(agent、模型)不带到下一台。
                  key={machineContext?.machine.deviceId ?? 'local'}
                  // 这是**对话页**(以及联系人页/移动端全屏)的创建草稿:首条消息是一条普通私聊消息,
                  // 发完原地进入那个 Agent 的私聊(spec agent-creation)。会话页不走这一路。
                  creationSurface="chat-page"
                  birthChatId={snapshot.birthGroup?.chatId}
                  {...machineComposerProps(machineContext, { projectId: effectiveProjectId, blockReason, isContextPending })}
                />
              </LibraryHostProvider>
            </div>
            {projectError ? (
              <p
                role="alert"
                data-testid="create-implicit-project-error"
                className="mt-3 text-center text-xs text-foreground-destructive"
              >
                {projectError}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </SessionShellProvider>
  );
});
