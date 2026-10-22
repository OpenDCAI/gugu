// #6264 一套工作台:看着别的机器上的一条会话时,这台电脑才有的那几件事 —— 会话视图本身与本机同一个。
//  · 那台机器上的 agent 调 `open_in_tab` / 程序要「打开网页」:开进这条会话的工作区(remote-pane-viewer.ts)。屏上的
//    每一条都订着,那台机器的闲置回收也认这份订阅(「有人看着」);
//  · 点会话里的 localhost 链接:开进这条会话的浏览器格(页签自己经 SSH 转端口过去);
//  · 会话输出里冒出 `localhost:5173` ⇒ 核实不是咕咕自己的端口后记进那台机器的端口表(machine-port-scanner.ts);
//  · 那台机器上新发现的服务弹一声「可以打开了」(照 VS Code 自动转发后的那条通知),没在看就先记着。
// 只装一次(启动时)。触发:进出会话页、换任务、那台机器连上 / 断开 —— 都是事件,❌ 定时查。
import { closeSessionPaneTab, sessionPaneTabs } from '@renderer/features/sessions/stores/session-pane-tabs';
import { comparer, reaction } from 'mobx';
import { openGroupFileLink } from '@/components/markdown/fileLinks';
import type { SessionpagePaneOpenRequest } from '@gugu/session-core/session-record/contract';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { asProvisioned, getSessionPageStore } from '@renderer/features/sessions/stores/session-selectors';
import { toast } from '@renderer/lib/hooks/use-toast';
import { events, invokeOnMachine, onMachineEvent, rpc, rpcOn } from '@renderer/lib/ipc';
import { machineLinkState, subscribeMachineLink } from '@renderer/lib/machine-clients';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { setRemoteLinkTargetProvider } from '@renderer/lib/remote-link-target';
import { observeCommittedTurns, observePtyOutput } from '@renderer/lib/session-output-observers';
import { sessionPagesOnScreen } from '@renderer/app/sessions-on-screen';
import { appState } from '@renderer/lib/stores/app-state';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { log } from '@renderer/utils/logger';
import { SESSION_HOST_PANE } from '@shared/lib/ipc/session-host-device-frames';
import { remotePortDetectedChannel } from '@shared/remote-ports';
import { remoteHostsStore } from '../remote-hosts-store';
import { createMachinePortScanner } from './machine-port-scanner';
import { openExternalFromMachine } from './remote-open-external';
import {
  startRemotePaneViewer,
  syncRemotePaneViewers,
  type PaneLink,
  type PaneOpenResult,
  type RemotePaneViewer,
  type WantedPaneViewer,
} from './remote-pane-viewer';
import { remoteLoopbackPort, remoteWorkspaceTools } from './remote-workspace-routing';

type ViewedMachineSession = { deviceId: string; projectId: string; sessionId: string };

/**
 * 此刻在屏上的、在别的机器上的每一条会话(「在屏上」只在 app/sessions-on-screen.ts 定义一处)。
 * 屏上的每一条都订着(见下面的 reaction):那台机器的闲置回收认这些订阅,❌ 只订主窗那一页 ——
 * 摆在别的块里、开在窗里的会话会被那台机器当成没人看停掉(#92)。
 */
export function machineSessionsOnScreen(): ViewedMachineSession[] {
  return sessionPagesOnScreen().flatMap(({ projectId, sessionId }) => {
    const deviceId = machineRegistry.machineOf(projectId);
    return deviceId ? [{ deviceId, projectId, sessionId }] : [];
  });
}

/** 此刻在看的、在别的机器上的那条会话(主窗正显示的那一页;不是 ⇒ null):焦点给谁 —— 链接、端口通知开在哪。 */
export function viewedMachineSession(): ViewedMachineSession | null {
  if (appState.navigation.currentViewId !== 'session') return null;
  const params = appState.navigation.viewParamsStore['session'] as { projectId?: string; sessionId?: string } | undefined;
  if (!params?.projectId || !params.sessionId) return null;
  const deviceId = machineRegistry.machineOf(params.projectId);
  return deviceId ? { deviceId, projectId: params.projectId, sessionId: params.sessionId } : null;
}

function hasBrowser(deviceId: string): boolean {
  return remoteWorkspaceTools(remoteHostsStore.device(deviceId) ?? null).includes('browser');
}

function sessionView(projectId: string, sessionId: string) {
  return asProvisioned(getSessionPageStore(projectId, sessionId))?.viewModel ?? null;
}

/** 在这条会话的浏览器格里开一个网址(localhost 的端口由页签自己经 SSH 转过去)。 */
function openInBrowserTab(projectId: string, sessionId: string, url: string): boolean {
  const view = sessionView(projectId, sessionId);
  if (!view) return false;
  view.activePane.open('browser', { initialUrl: url }, { preview: false });
  return true;
}

function hasBrowserTab(projectId: string, sessionId: string): boolean {
  const view = sessionView(projectId, sessionId);
  return !!view?.paneLayout.groups.some((group) => group.pane.resolvedTabs.some((tab) => tab.kind === 'browser'));
}

/** 那台机器上的 agent / 程序要开的东西,开进这条会话的工作区(与本机 open_in_tab 同一个动作)。 */
function openRequested(session: ViewedMachineSession, request: SessionpagePaneOpenRequest): PaneOpenResult | Promise<PaneOpenResult> {
  const browser = hasBrowser(session.deviceId);
  if (request.target.kind === 'tabs' || request.target.kind === 'close-tab') {
    const view = sessionView(session.projectId, session.sessionId);
    if (!view) return { ok: false, failure: 'open_failed' };
    if (request.target.kind === 'tabs') return { ok: true, tabs: sessionPaneTabs(view.paneLayout) };
    return closeSessionPaneTab(view.paneLayout, request.target.tabId).then(
      (result) => ({ ok: true, ...result }),
      (error: unknown) => ({ ok: false, failure: 'open_failed', error: error instanceof Error ? error.message : String(error) }),
    );
  }
  if (request.target.kind === 'external') {
    return openExternalFromMachine(
      {
        deviceId: session.deviceId,
        sessionId: session.sessionId,
        hasBrowserTab: () => hasBrowserTab(session.projectId, session.sessionId),
        openInBrowserTab: (url) => void openInBrowserTab(session.projectId, session.sessionId, url),
      },
      { url: request.target.url, requestId: request.requestId, browser }
    );
  }
  // A group's file (摩擦单 F10) is no page for the browser cell: opened in its group, as a chat link is (not in that
  // chat: the person is told, the machine hears it failed).
  const groupFileOpened = request.target.kind === 'browser' ? openGroupFileLink(request.target.url) : null;
  if (groupFileOpened !== null) return groupFileOpened.then((opened): PaneOpenResult => (opened ? { ok: true } : { ok: false, failure: 'open_failed' }));
  if (request.target.kind === 'browser' && !browser) return { ok: false, failure: 'no_browser' };
  const view = sessionView(session.projectId, session.sessionId);
  if (!view) return { ok: false, failure: 'open_failed' };
  const preview = request.intent === 'preview';
  // 和本机 agent 打开同一个位置:对话右边并排(spec session-page「并排」)。
  if (request.target.kind === 'file') view.paneLayout.open('file', { path: request.target.path }, { preview, beside: true, activate: false });
  else view.showPage(request.target.url, { preview, reload: true, beside: true, activate: false });
  return { ok: true, tabs: sessionPaneTabs(view.paneLayout) };
}

function paneLink(deviceId: string): PaneLink {
  return {
    invoke: (channel, payload) => invokeOnMachine(deviceId, channel, payload),
    onOpenEvent: (cb) => onMachineEvent(deviceId, { name: SESSION_HOST_PANE.open }, cb),
    onReconnected: (cb) => {
      let open = machineLinkState(deviceId) === 'open';
      return subscribeMachineLink(deviceId, () => {
        const now = machineLinkState(deviceId) === 'open';
        if (now && !open) cb();
        open = now;
      });
    },
  };
}

/** 没在看时攒着的「可以打开了」每台机器最多几条(一次测试起一串临时端口时 ❌ 刷屏,VS Code #112724)。 */
export const MAX_PENDING_NOTICES = 3;

let wired = false;

export function ensureMachineSessionWiring(): void {
  if (wired) return;
  wired = true;

  // 看着 = 屏上每一条别的机器上的、会话页已经准备好的会话都订上它的 open_in_tab(一个任务一条会话);离开屏幕 = 退订。
  // 那台机器的闲置回收据此判「有人看着」(remote-pane watching)。会话页还没准备好(远端工作区正在挂载)就不订:
  // 订阅应答里攒着的那几条要开进这一页,页还没有就只能答「没开成」。
  // 浏览器格读在这里(跟着那台机器的直连变),订着的就地改,❌ 只在开始订的那一刻取一次。
  const viewers = new Map<string, RemotePaneViewer>();
  reaction(
    () =>
      machineSessionsOnScreen().filter((page) => sessionView(page.projectId, page.sessionId)).flatMap((page) => {
        const browser = hasBrowser(page.deviceId);
        return [...(sessionRegistry.get(page.sessionId)?.sessions.keys() ?? [])].sort().map((sessionId) => ({ page, sessionId, browser }));
      }),
    (watched) => {
      const wanted = new Map<string, WantedPaneViewer>();
      for (const { page, sessionId, browser } of watched) {
        wanted.set(`${page.deviceId}\n${page.projectId}\n${page.sessionId}\n${sessionId}`, {
          browser,
          start: () =>
            startRemotePaneViewer({
              link: paneLink(page.deviceId),
              deviceId: page.deviceId,
              sessionId,
              browser,
              open: (request) => openRequested(page, request),
              log: (message, fields) => log.warn(`[machine-pane] ${message}`, fields),
            }),
        });
      }
      syncRemotePaneViewers(viewers, wanted);
    },
    { equals: comparer.structural, fireImmediately: true }
  );

  setRemoteLinkTargetProvider(() => {
    const viewed = viewedMachineSession();
    if (!viewed) return null;
    const browser = hasBrowser(viewed.deviceId);
    return {
      canOpenInBrowserTab: browser,
      openInBrowserTab: (url) => void openInBrowserTab(viewed.projectId, viewed.sessionId, url),
      claimLoopback: (url) => {
        if (remoteLoopbackPort(url) === null) return false;
        if (browser) openInBrowserTab(viewed.projectId, viewed.sessionId, url);
        else
          toast({
            title: translateSessionMessage('remotePorts.tunnelLoopback', { device: remoteHostsStore.device(viewed.deviceId)?.label ?? viewed.deviceId }),
            tier: 'warning',
          });
        return true;
      },
    };
  });

  const scanner = createMachinePortScanner({
    machineOf: (id) => machineRegistry.machineOf(id),
    hasBrowser,
    report: (found) => void rpc.remotePorts.detect(found).catch(() => undefined),
    ownPorts: (deviceId) =>
      rpcOn(deviceId)
        .machine.listeningPorts()
        .then((result) => (result.success ? (result.data.ownPorts ?? null) : null)),
  });
  observePtyOutput((ptySessionId, data) => scanner.onPtyOutput(ptySessionId, data));
  observeCommittedTurns((target, turn) => scanner.onCommittedTurn(target, turn));

  // 新发现的服务:人正看着那台机器上的会话就当场弹;没在看就先记着,下次打开那台机器上的会话时再弹 ——
  // ❌ 丢掉(d22 实机:agent 打出 localhost:8765 时人不在那一页,事后什么都没看到)。
  const pending = new Map<string, number[]>();
  const show = (session: ViewedMachineSession, remotePort: number) => {
    const device = remoteHostsStore.device(session.deviceId)?.label ?? session.deviceId;
    toast({
      title: translateSessionMessage('remotePorts.detected', { device, port: remotePort }),
      description: translateSessionMessage('remotePorts.detectedDetail', { port: remotePort }),
      tier: 'info',
      action: {
        label: translateSessionMessage('remotePorts.open'),
        // 端口是整台机器的:开进人此刻看着的这条会话的浏览器格(他就在这儿)。
        onClick: () => void openInBrowserTab(session.projectId, session.sessionId, `http://localhost:${remotePort}/`),
      },
    });
  };
  events.on(remotePortDetectedChannel, (found) => {
    const viewed = viewedMachineSession();
    if (viewed && viewed.deviceId === found.deviceId) {
      show(viewed, found.remotePort);
      return;
    }
    const list = (pending.get(found.deviceId) ?? []).filter((port) => port !== found.remotePort);
    list.push(found.remotePort);
    pending.set(found.deviceId, list.slice(-MAX_PENDING_NOTICES));
  });
  reaction(
    () => viewedMachineSession(),
    (viewed) => {
      if (!viewed) return;
      const ports = pending.get(viewed.deviceId);
      if (!ports) return;
      pending.delete(viewed.deviceId);
      for (const port of ports) show(viewed, port);
    },
    { equals: comparer.structural }
  );
}
