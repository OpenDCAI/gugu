import { followMovedFiles } from '@renderer/features/sessions/file-view/follow-moved-files';
import { findSessionAnywhere } from '@renderer/features/sessions/stores/session-selectors';
import { workspaceSession } from '@shared/extensions/app-runtime-protocol';
import { useEffect } from 'react';
import { openRequestedGroupParticipant } from '@renderer/features/chats/open-group-participant-session';
import { readSessionPaneTabs } from '@renderer/features/sessions/stores/session-pane-tabs';
import { openLink } from '@/lib/guguLinks';
import { GROUP_FILE_NOT_OPENED } from '@shared/extensions/app-runtime-protocol';
import { openSessionInSessionWhenReady } from '@renderer/features/sessions/open-session-in-session';
import { isScreenView, showSessionBeside } from './screen-layout-actions';
import { appState } from '@renderer/lib/stores/app-state';
import { answerMachinePreviewReads } from '@renderer/features/sessions/workspace-backend/machine-preview-reads';
import { answerAppFileWatches } from '@renderer/features/extensions/app-file-watches-elsewhere';
import { notify } from '@/lib/notices';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { machineOfProject } from '@renderer/features/remote-hosts/workspace/machine-workspace-backend';
import { onMachineReconnected } from '@renderer/lib/machine-clients';
import { retryServerVersionMatch } from '@/lib/serverVersionRetry';
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import { getSessionPageStore, getWorkspaceForSession } from '@renderer/features/sessions/stores/session-selectors';
import { workspaceEvents, workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { fileChangesChannel } from '@shared/core/fs/fsEvents';
import { log } from '@renderer/utils/logger';
import {
  manageSessionTabsWhenReady,
  openHostRequestedBrowserInSessionWhenReady,
  openHostRequestedExtensionInSessionWhenReady,
  openHostRequestedFileInSessionWhenReady,
} from '@renderer/features/sessions/stores/open-file-in-file-editor';
import { toast } from '@renderer/lib/hooks/use-toast';
import { events, rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { revealSessionpage } from '@/hooks/useSessionpageReveal';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { openShellFeedback } from '@renderer/lib/open-shell-feedback';
import { openShellSettings } from '@renderer/lib/open-shell-settings';
import {
  menuGiveFeedbackChannel,
  menuOpenSettingsChannel,
  menuQuitRequestedChannel,
  notificationFocusSessionChannel,
  appFileHeardElsewhereChannel,
  appFileWatchElsewhereChannel,
  appFileMachineOutdatedChannel,
  remotePreviewReadChannel,
  remotePreviewReadResultChannel,
  sessionManageTabsChannel,
  sessionManageTabsResultChannel,
  sessionOpenFileInPaneChannel,
  workingCopyMovedChannel,
  sessionOpenFileInPaneResultChannel,
  sessionOpenBrowserInPaneChannel,
  sessionCancelBrowserAcquireChannel,
  sessionOpenBrowserInPaneResultChannel,
  sessionOpenExtensionInPaneChannel,
  sessionOpenExtensionInPaneResultChannel,
} from '@shared/events/appEvents';
import { browserLinkCopiedChannel } from '@shared/events/browserEvents';

export function AppMenuEvents() {
  const { navigate } = useNavigate();
  const showConfirmQuitModal = useShowModal('confirmActionModal');

  // 应用菜单「设置…」(⌘,):设置是壳的弹窗,在哪个 tab 上按都开它。本页常驻挂载(切走只是藏起来),
  // 所以这条 IPC 在「消息」「通讯录」上一样收得到。
  useEffect(() => events.on(menuOpenSettingsChannel, () => openShellSettings()), []);

  useEffect(() => {
    return events.on(menuQuitRequestedChannel, () => {
      showConfirmQuitModal({
        title: 'Quit gugu?',
        description: 'Active terminal sessions and running agents will stop when the app quits.',
        confirmLabel: 'Quit',
        onSuccess: () => {
          void rpc.app.quit();
        },
      });
    });
  }, [showConfirmQuitModal]);

  useEffect(() => {
    return events.on(menuGiveFeedbackChannel, () => {
      openShellFeedback();
    });
  }, []);

  useEffect(() => {
    return events.on(browserLinkCopiedChannel, ({ kind }) => {
      const title =
        kind === 'url'
          ? 'Browser URL copied'
          : kind === 'image'
            ? 'Image URL copied'
            : 'Link copied';
      toast({ title });
    });
  }, []);

  useEffect(() => {
    const disposers = new Set<() => void>();

    const unlisten = events.on(
      notificationFocusSessionChannel,
      ({ projectId, sessionId, beside, groupParticipantRequestId }) => {
        const groupEntry = sessionId ? openRequestedGroupParticipant({ projectId, sessionId }, groupParticipantRequestId) : undefined;
        if (groupEntry) {
          disposers.add(groupEntry);
          return;
        }
        // A task card on the screen view: beside what is there, the layout kept.
        if (beside && sessionId && isScreenView(appState.navigation.currentViewId)) {
          disposers.add(openSessionInSessionWhenReady({ projectId, sessionId, onReady: () => showSessionBeside({ projectId, sessionId }) }));
          return;
        }
        navigate('session', { projectId, sessionId: sessionId });
        revealSessionpage(); // a banner's click, or a composer an App named: the session in front, from any page
        if (!sessionId) return;

        const dispose = openSessionInSessionWhenReady({ projectId, sessionId });

        disposers.add(dispose);
      }
    );

    return () => {
      unlisten();
      disposers.forEach((dispose) => dispose());
      disposers.clear();
    };
  }, [navigate]);

  useEffect(
    () =>
      events.on(workingCopyMovedChannel, ({ workspace, from, to }) => {
        const sessionId = workspaceSession({ workspace });
        const found = sessionId ? findSessionAnywhere(sessionId) : undefined;
        if (!found) return;
        followMovedFiles(found.viewModel.paneLayout, found.viewModel.workspace?.path, from, to);
      }),
    []
  );

  useEffect(() => {
    const disposers = new Set<() => void>();
    const unlisten = events.on(sessionOpenFileInPaneChannel, (request) => {
      const dispose = openHostRequestedFileInSessionWhenReady({
        ...request,
        intent: request.intent === 'pinned' ? 'newTab' : 'navigate',
        onResult: (result) => {
          events.emit(sessionOpenFileInPaneResultChannel, {
            requestId: request.requestId,
            ...result,
            ...(result.success ? { tabs: readSessionPaneTabs(request.projectId, request.sessionId) } : {}),
          });
        },
      });
      disposers.add(dispose);
    });
    return () => {
      unlisten();
      disposers.forEach((dispose) => dispose());
      disposers.clear();
    };
  }, []);

  // A file call its machine is too old for: one notice a machine, whose button updates it the way a device row's retry does,
  // and lands on that row, which says how it goes.
  useEffect(
    () =>
      events.on(appFileMachineOutdatedChannel, ({ deviceId, label }) => {
        const key = `machine-outdated:${deviceId}`;
        const failed = () => notify({ key, title: translateSessionMessage('remoteHost.status.updateFailed', { device: label }), tier: 'error' });
        notify({
          key,
          title: translateSessionMessage('remoteHost.notice.serverTooOld', { device: label }),
          tier: 'error',
          action: {
            label: translateSessionMessage('remoteHost.notice.updateMachine'),
            onClick: () => {
              openShellSettings('devices');
              void retryServerVersionMatch(deviceId).then((requested) => {
                if (!requested) failed();
              }, failed);
            },
          },
        });
      }),
    []
  );

  // A page hearing one file on another machine: that machine's changes reach this window, not main.
  useEffect(
    () =>
      answerAppFileWatches({
        onRequest: (handler) => events.on(appFileWatchElsewhereChannel, handler),
        reply: (heard) => events.emit(appFileHeardElsewhereChannel, heard),
        locate: (sessionId) => {
          for (const projectId of getProjectManagerStore().projects.keys()) {
            const workspaceId = getSessionPageStore(projectId, sessionId)?.workspaceId;
            const workspace = getWorkspaceForSession(projectId, sessionId);
            if (workspaceId && workspace) return { projectId, workspaceId, root: workspace.path };
          }
          return null;
        },
        onFileChanges: (handler) => workspaceEvents.on(fileChangesChannel, handler),
        watchDirectory: async ({ projectId, workspaceId }, directory) => {
          const files = workspaceRpc(projectId).files;
          const watched = await files.watchDirectory(projectId, workspaceId, directory);
          if (!watched.success) throw new Error(JSON.stringify(watched.error));
          return () => void files.releaseDirectoryWatch(projectId, workspaceId, watched.data.leaseId);
        },
        onMachineBack: ({ projectId }, handler) => {
          const deviceId = machineOfProject(projectId);
          return deviceId ? onMachineReconnected(deviceId, handler) : () => {};
        },
        warn: (message, data) => log.warn(message, data),
      }),
    []
  );

  // #6264 别的机器上的网页 / HTML 预览:主进程的 `gugu-preview://` 要一块字节,按项目所在的机器去取。
  useEffect(
    () =>
      answerMachinePreviewReads({
        onRequest: (handler) => events.on(remotePreviewReadChannel, handler),
        reply: (result) => events.emit(remotePreviewReadResultChannel, result),
        read: async (projectId, workspaceId, chunk) => {
          const result = await rpc.workspace.files.readChunk(projectId, workspaceId, chunk);
          if (result.success) return result.data;
          throw Object.assign(new Error(String(result.error.type)), { code: String(result.error.type) });
        },
      }),
    []
  );

  useEffect(() => {
    const disposers = new Set<() => void>();
    const acquisitions = new Map<string, () => void>();
    const cancel = events.on(sessionCancelBrowserAcquireChannel, ({ requestId }) => {
      acquisitions.get(requestId)?.();
      acquisitions.delete(requestId);
    });
    const unlisten = events.on(sessionOpenBrowserInPaneChannel, (request) => {
      // A group's file (session_open_in_tab with a gugu-file link, 摩擦单 F10): opened in its group, as a chat link is.
      const groupFileOpened = openLink(request.linkTarget ?? request.url);
      if (groupFileOpened !== null) {
        void groupFileOpened.then(
          (opened) =>
            events.emit(
              sessionOpenBrowserInPaneResultChannel,
              opened
                ? { requestId: request.requestId, success: true }
                : { requestId: request.requestId, success: false, error: GROUP_FILE_NOT_OPENED },
            ),
          (error: unknown) =>
            events.emit(sessionOpenBrowserInPaneResultChannel, {
              requestId: request.requestId,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
        return;
      }
      const dispose = openHostRequestedBrowserInSessionWhenReady({
        ...request,
        intent: request.intent === 'pinned' ? 'newTab' : 'navigate',
        onResult: (result) => {
          acquisitions.delete(request.requestId);
          events.emit(sessionOpenBrowserInPaneResultChannel, {
            requestId: request.requestId,
            ...result,
            ...(result.success ? { tabs: readSessionPaneTabs(request.projectId, request.sessionId) } : {}),
          });
        },
      });
      disposers.add(dispose);
      if (request.acquire) acquisitions.set(request.requestId, dispose);
    });
    return () => {
      unlisten();
      cancel();
      disposers.forEach((dispose) => dispose());
      disposers.clear();
    };
  }, []);

  useEffect(() => {
    const disposers = new Set<() => void>();
    const unlisten = events.on(sessionOpenExtensionInPaneChannel, (request) => {
      // 从会话页外面来的(扩展横幅、gugu://ext 链接):先把那个任务带到屏幕上。
      if (request.reveal) {
        navigate('session', { projectId: request.projectId, sessionId: request.sessionId });
        revealSessionpage();
      }
      const dispose = openHostRequestedExtensionInSessionWhenReady({
        ...request,
        intent: request.intent === 'pinned' ? 'newTab' : 'navigate',
        onResult: (result) => {
          events.emit(sessionOpenExtensionInPaneResultChannel, {
            requestId: request.requestId,
            ...result,
            ...(result.success ? { tabs: readSessionPaneTabs(request.projectId, request.sessionId) } : {}),
          });
        },
      });
      disposers.add(dispose);
    });
    return () => {
      unlisten();
      disposers.forEach((dispose) => dispose());
      disposers.clear();
    };
  }, [navigate]);

  useEffect(() => {
    const disposers = new Set<() => void>();
    const off = events.on(sessionManageTabsChannel, (request) => {
      disposers.add(manageSessionTabsWhenReady({ ...request, onResult: (result) => {
        events.emit(sessionManageTabsResultChannel, { requestId: request.requestId, ...result });
      } }));
    });
    return () => { off(); disposers.forEach((dispose) => dispose()); };
  }, []);

  return null;
}
