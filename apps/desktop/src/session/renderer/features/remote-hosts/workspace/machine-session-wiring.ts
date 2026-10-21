// #6264 一套工作台:看着别的机器上的一条会话时,这台电脑才有的那几件事 —— 会话视图本身与本机同一个。
//  · 那台机器上的 agent 调 `open_in_tab` / 程序要「打开网页」:开进这条会话的工作区(remote-pane-viewer.ts);
//  · 点会话里的 localhost 链接:开进这条会话的浏览器格(页签自己经 SSH 转端口过去);
//  · 会话输出里冒出 `localhost:5173` ⇒ 核实不是咕咕自己的端口后记进那台机器的端口表(machine-port-scanner.ts);
//  · 那台机器上新发现的服务弹一声「可以打开了」(照 VS Code 自动转发后的那条通知),没在看就先记着。
// 只装一次(启动时)。触发:进出会话页、换任务、那台机器连上 / 断开 —— 都是事件,❌ 定时查。
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
import { appState } from '@renderer/lib/stores/app-state';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { log } from '@renderer/utils/logger';
import { SESSION_HOST_PANE } from '@shared/lib/ipc/session-host-device-frames';
import { remotePortDetectedChannel } from '@shared/remote-ports';
import { remoteHostsStore } from '../remote-hosts-store';
import { createMachinePortScanner } from './machine-port-scanner';
import { openExternalFromMachine } from './remote-open-external';
import { startRemotePaneViewer, type PaneLink, type PaneOpenResult } from './remote-pane-viewer';
import { remoteLoopbackPort, remoteWorkspaceTools } from './remote-workspace-routing';

type ViewedMachineSession = { deviceId: string; projectId: string; sessionId: string };

/** 此刻在看的、在别的机器上的那条会话(不是 ⇒ null)。 */
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
  view.recordOutput(
    request.target.kind === 'file' ? { kind: 'file', path: request.target.path } : { kind: 'page', url: request.target.url }
  );
  return { ok: true };
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

  // 看着 = 订上这条会话的 open_in_tab(一个任务一条会话);换任务 / 离开会话页 = 退订。
  let stopViewers: Array<() => void> = [];
  reaction(
    () => {
      const session = viewedMachineSession();
      if (!session) return null;
      const sessions = [...(sessionRegistry.get(session.sessionId)?.sessions.keys() ?? [])].sort();
      return { ...session, sessions };
    },
    (viewed) => {
      for (const stop of stopViewers) stop();
      stopViewers = [];
      if (!viewed) return;
      const link = paneLink(viewed.deviceId);
      stopViewers = viewed.sessions.map((sessionId) =>
        startRemotePaneViewer({
          link,
          deviceId: viewed.deviceId,
          sessionId,
          browser: hasBrowser(viewed.deviceId),
          open: (request) => openRequested(viewed, request),
          log: (message, fields) => log.warn(`[machine-pane] ${message}`, fields),
        })
      );
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
