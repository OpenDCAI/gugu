import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { readComposerVerbChat, setComposerVerb, takeComposerCarry, useComposerVerb } from '@/lib/composerVerbBridge';
import { platform } from '@/platform';
import { machineLibraryHost } from '@renderer/features/library/library-host';
import { useNewSessionMachine } from '@renderer/features/remote-hosts/use-new-session-machine';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { sessionpageMessageHost } from '@renderer/lib/sessionpage-message-host';
import { log } from '@renderer/utils/logger';
import { ComposerBirthGroupChip, ComposerProjectPicker, mountedProjects } from './composer-context-tray';
import { composerDrafts } from './composer-drafts';
import { ComposerTray } from './composer-tray';
import { ensureImplicitSessionHomeProjectId } from './implicit-session-home-project';
import { NewSessionComposer } from './new-session-page';
import { sessionComposerDockBandClassName, sessionComposerDockedWidthClassName } from './session-composer-styles';
import { cancelComposerVerb, composerVerbLook } from './composer-verb-tag';
import { machineComposerProps } from './use-machine-create-target';

export function taskDispatchDraftKey(chatId: string): string {
  return `task:${chatId}`;
}

/**
 * gugu-dev#181「派任务」:对话块的输入框选了「新任务」(composerVerbBridge)时,换上来的就是这个框 —— 与新建会话页
 * 同一个托盘 + NewSessionComposer,❌ 另一条建会话的路。发出去的那句话由宿主落成这个对话里的一张任务卡
 * (taskChatId),结果回这里;建完人留在原处、框还原成发消息。
 * 托盘是 项目 · 这台电脑 · 群名。项目按这个对话记(没选过 = 最近一次选的);`joinChat` = 这个 agent 进群
 * (群里派的;私聊里 agent 进不去,卡留在私聊、结果回它自己的会话)。项目块里的新任务是项目首页那个框(ProjectTaskComposer)。
 */
export const TaskDispatchComposer = observer(function TaskDispatchComposer({
  chatId,
  chatName,
  joinChat = false,
  verbKey = chatId,
  onSessionCreated,
  placeholder,
}: {
  chatId: string;
  /** 群名(托盘上那一格);`joinChat` 时要。 */
  chatName?: string;
  joinChat?: boolean;
  /** 这个词记在 composerVerbBridge 的哪一格;缺省 = 这个对话(没有项目的会话里选的记在那条会话上,卡落它的私聊)。 */
  verbKey?: string;
  /** 建好之后(框已还原):会话里派的,新会话拼到右边。 */
  onSessionCreated?: (result: { projectId: string; sessionId: string }) => void;
  /** 缺省「想让 X 做点什么？」;会话里派的说清是一个新的 agent。 */
  placeholder?: (agentName: string) => string;
}) {
  const { translate } = useSessionMessages();
  const draftKey = taskDispatchDraftKey(verbKey);
  // 选词那一刻框里写着的话跟过来:要在 NewSessionComposer 挂上(读草稿)之前放好。
  useState(() => {
    const carried = takeComposerCarry(verbKey);
    if (carried) composerDrafts.set(draftKey, carried);
    return null;
  });
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const localDeviceId = useLocalDeviceId();
  const remembered = useChatProjectMemory(chatId, localDeviceId);
  useEffect(() => {
    if (remembered && selectedId === undefined) setSelectedId(remembered);
  }, [remembered, selectedId]);
  const implicitProjectId = useImplicitProjectId(!selectedId);

  const pickProject = (projectId: string | undefined) => {
    setSelectedId(projectId);
    if (localDeviceId) {
      void sessionpageMessageHost().rememberTaskProject(chatId, localDeviceId, projectId ?? null).catch((error: unknown) => {
        log.warn('remember the project picked for a chat failed', { chatId, error: error instanceof Error ? error.message : String(error) });
      });
    }
  };
  const { remote, machineContext, devicePicker, projectPicker } = useNewSessionMachine(
    <ComposerProjectPicker includeRemote selectedId={selectedId} onSelect={pickProject} />
  );
  const effectiveProjectId = selectedId ?? implicitProjectId;

  const close = () => setComposerVerb(verbKey, null);
  return (
    <div data-testid="task-dispatch-composer" data-chat-id={chatId}>
      <ComposerTray
        projectPicker={projectPicker}
        devicePicker={devicePicker}
        folderPicker={joinChat && chatName ? <ComposerBirthGroupChip name={chatName} /> : null}
        host={machineContext?.host ?? machineLibraryHost(null)}
      >
        <NewSessionComposer
          key={remote?.deviceId ?? 'local'}
          draftKey={draftKey}
          placeholder={placeholder ?? ((agent) => translate('taskDispatch.placeholder', { agent }))}
          verb={composerVerbLook('task', { label: translate('taskDispatch.task'), onCancel: () => cancelComposerVerb(verbKey, draftKey), testId: 'task-dispatch' })}
          creationSurface="session-page"
          taskChatId={chatId}
          openAfterCreate={false}
          birthChatId={joinChat ? chatId : undefined}
          {...machineComposerProps(machineContext, { projectId: effectiveProjectId })}
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
 * 对话底下那一格:输入框选了「新任务」就摆新任务的框,没选 = 什么都不摆(对话自己的框在)。
 * 对话块放这一个(项目块的新任务是项目首页那个框),与 InputArea 收起自己是同一个读数(useComposerVerb)。
 */
export function ComposerVerbDock({ chatId }: { chatId: string }) {
  const verb = useComposerVerb(chatId);
  if (!verb) return null;
  // 群名、派出去的 agent 进不进得了这个对话,由选词的那个输入框记下(composerVerbBridge)。
  const chat = readComposerVerbChat(chatId);
  return (
    <div className={sessionComposerDockBandClassName}>
      <div className={sessionComposerDockedWidthClassName}>
        <TaskDispatchComposer chatId={chatId} chatName={chat?.name} joinChat={chat?.joinable} />
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
function useChatProjectMemory(chatId: string, deviceId: string | null): string | undefined {
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!deviceId) return;
    let live = true;
    void sessionpageMessageHost().rememberedTaskProject(chatId, deviceId).then(
      (id) => {
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
