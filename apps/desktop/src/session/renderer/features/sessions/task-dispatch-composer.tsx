import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { Sparkles, X } from '@/lib/icons';
import { rememberAgentCreateProject, readAgentCreateDefaults } from '@/lib/agentCreateDefaults';
import { setComposerVerb, takeComposerCarry, useComposerVerb } from '@/lib/composerVerbBridge';
import { platform } from '@/platform';
import { rememberedAgentCreateProject } from '@gugu/core/shared/ui/agentCreateDefaultsModels';
import { machineLibraryHost } from '@renderer/features/library/library-host';
import { useNewSessionMachine } from '@renderer/features/remote-hosts/use-new-session-machine';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { ComposerBirthGroupChip, ComposerProjectPicker, mountedProjects } from './composer-context-tray';
import { composerDrafts } from './composer-drafts';
import { ComposerTray } from './composer-tray';
import { ScheduleDispatchComposer } from './schedule-dispatch-composer';
import { ensureImplicitSessionHomeProjectId } from './implicit-session-home-project';
import { NewSessionComposer } from './new-session-page';
import { sessionComposerDockBandClassName, sessionComposerDockedWidthClassName, sessionComposerTrayTriggerClassName } from './session-composer-styles';
import { machineComposerProps, useMachineCreateContext } from './use-machine-create-target';
import { getProjectStore } from '@renderer/features/projects/stores/project-selectors';
import { machineRegistry } from '@renderer/lib/machine-routing';

export function taskDispatchDraftKey(chatId: string): string {
  return `task:${chatId}`;
}

/**
 * gugu-dev#181「派任务」:对话的输入框选了「新任务」(composerVerbBridge)时,换上来的就是这个框 —— 与新建会话页
 * 同一个托盘 + NewSessionComposer,❌ 另一条建会话的路。发出去的那句话由宿主落成这个对话里的一张任务卡
 * (taskChatId),结果回这里;建完人留在原处、框还原成发消息,会话放哪由 `onSessionCreated` 定。
 *
 *  · 项目块(`projectId` 给定):建在这个项目里(它在哪台机器上就在哪台跑),卡落项目群;项目、机器不可选,
 *    从哪个文件夹开工由项目块的文件夹卡给(`workspaceId`)。
 *  · 对话块:托盘是 项目 · 这台电脑 · 群名。项目按这个对话记(没选过 = 最近一次选的);`joinChat` = 这个 agent 进群
 *    (群里派的;私聊里 agent 进不去,卡留在私聊、结果回它自己的会话)。
 */
export const TaskDispatchComposer = observer(function TaskDispatchComposer({
  chatId,
  chatName,
  projectId: fixedProjectId,
  joinChat = false,
  workspaceId,
  onSessionCreated,
}: {
  chatId: string;
  /** 群名(托盘上那一格);`joinChat` 时要。 */
  chatName?: string;
  projectId?: string;
  joinChat?: boolean;
  /** 项目块:文件夹卡上选的那个文件夹;缺省 = 项目根目录。 */
  workspaceId?: string | null;
  onSessionCreated?: (result: { projectId: string; sessionId: string }) => void;
}) {
  const { translate } = useSessionMessages();
  const draftKey = taskDispatchDraftKey(chatId);
  // 选词那一刻框里写着的话跟过来:要在 NewSessionComposer 挂上(读草稿)之前放好。
  useState(() => {
    const carried = takeComposerCarry(chatId);
    if (carried) composerDrafts.set(draftKey, carried);
    return null;
  });
  const [selectedId, setSelectedId] = useState<string | undefined>(fixedProjectId);
  const localDeviceId = useLocalDeviceId();
  const remembered = useChatProjectMemory(fixedProjectId ? null : chatId, localDeviceId);
  useEffect(() => {
    if (!fixedProjectId && remembered && selectedId === undefined) setSelectedId(remembered);
  }, [fixedProjectId, remembered, selectedId]);
  const implicitProjectId = useImplicitProjectId(!fixedProjectId && !selectedId);

  const pickProject = (projectId: string | undefined) => {
    setSelectedId(projectId);
    if (localDeviceId) {
      void rememberAgentCreateProject(localDeviceId, projectId ?? null, chatId).catch((error: unknown) => {
        log.warn('remember the project picked for a chat failed', { chatId, error: error instanceof Error ? error.message : String(error) });
      });
    }
  };
  const { remote, machineContext, devicePicker, projectPicker } = useNewSessionMachine(
    <ComposerProjectPicker includeRemote selectedId={selectedId} onSelect={pickProject} />
  );
  // 项目块:项目在哪台机器上,会话就建在哪台(与项目首页同一条)。
  const projectDevice = fixedProjectId ? machineRegistry.machineOf(fixedProjectId) : null;
  const projectMachine = useMachineCreateContext(fixedProjectId && projectDevice ? {
    deviceId: projectDevice, projectId: fixedProjectId, projectPath: getProjectStore(fixedProjectId)?.data?.path ?? null,
  } : null);
  const machine = fixedProjectId ? projectMachine : machineContext;
  const effectiveProjectId = selectedId ?? implicitProjectId;

  const close = () => setComposerVerb(chatId, null);
  return (
    <div data-testid="task-dispatch-composer" data-chat-id={chatId}>
      <ComposerTray
        projectPicker={
          <>
            <span className={sessionComposerTrayTriggerClassName} data-testid="task-dispatch-verb">
              <Sparkles className="size-3 shrink-0" />
              <span>{translate('taskDispatch.task')}</span>
              <button
                type="button"
                aria-label={translate('taskDispatch.cancel')}
                title={translate('taskDispatch.cancel')}
                onClick={close}
                className="-mr-1 grid size-4 place-items-center rounded-sm hover:bg-row-hover"
                data-testid="task-dispatch-cancel"
              >
                <X className="size-3" />
              </button>
            </span>
            {fixedProjectId ? null : projectPicker}
          </>
        }
        devicePicker={fixedProjectId ? null : devicePicker}
        folderPicker={joinChat && chatName ? <ComposerBirthGroupChip name={chatName} /> : null}
        host={machine?.host ?? machineLibraryHost(null)}
      >
        <NewSessionComposer
          key={fixedProjectId ? projectDevice ?? 'local' : remote?.deviceId ?? 'local'}
          draftKey={draftKey}
          placeholder={translate('taskDispatch.placeholder')}
          creationSurface="session-page"
          taskChatId={chatId}
          openAfterCreate={false}
          birthChatId={joinChat ? chatId : undefined}
          workspaceId={workspaceId ?? null}
          {...machineComposerProps(machine, { projectId: effectiveProjectId })}
          onSessionCreated={(result) => {
            close();
            onSessionCreated?.(result);
          }}
        />
      </ComposerTray>
    </div>
  );
});

/**
 * 对话底下那一格:输入框选了哪个词就摆哪个框(「新任务」/「定时任务」),没选 = 什么都不摆(对话自己的框在)。
 * 项目块、对话块都只放这一个,与 InputArea 收起自己是同一个读数(useComposerVerb)。
 */
export function ComposerVerbDock(props: Parameters<typeof TaskDispatchComposer>[0]) {
  const verb = useComposerVerb(props.chatId);
  if (!verb) return null;
  return (
    <div className={sessionComposerDockBandClassName}>
      <div className={sessionComposerDockedWidthClassName}>
        {verb === 'task'
          ? <TaskDispatchComposer {...props} />
          : <ScheduleDispatchComposer chatId={props.chatId} projectId={props.projectId} />}
      </div>
    </div>
  );
}

function useLocalDeviceId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve(platform.getLocalDeviceSelfSnapshot?.()).then(
      (self) => { if (live) setId(self?.device_id ?? null); },
      () => undefined,
    );
    return () => { live = false; };
  }, []);
  return id;
}

/** 这个对话在这台电脑上记着的项目(还挂在这台电脑上的才算);没记过 = 最近一次选的。 */
function useChatProjectMemory(chatId: string | null, deviceId: string | null): string | undefined {
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!chatId || !deviceId) return;
    let live = true;
    void readAgentCreateDefaults().then(
      (defaults) => {
        const id = rememberedAgentCreateProject(defaults, deviceId, chatId);
        if (live && id && mountedProjects().some((project) => project.id === id)) setProjectId(id);
      },
      (error: unknown) => log.warn('read the project remembered for a chat failed', { chatId, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => { live = false; };
  }, [chatId, deviceId]);
  return projectId;
}

/** 没选项目:与新建会话页同一个隐式工作目录(「未选择项目」是真状态,不是列表第一个)。 */
function useImplicitProjectId(wanted: boolean): string | undefined {
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!wanted || projectId) return;
    let live = true;
    void ensureImplicitSessionHomeProjectId().then(
      (id) => { if (live && id) setProjectId(id); },
      (error: unknown) => log.warn('prepare the implicit project for a task failed', { error: error instanceof Error ? error.message : String(error) }),
    );
    return () => { live = false; };
  }, [wanted, projectId]);
  return projectId;
}
