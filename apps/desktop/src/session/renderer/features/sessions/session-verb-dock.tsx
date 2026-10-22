import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { Clock } from '@/lib/icons';
import { PluginIcon } from '@renderer/lib/components/plugin-icon';
import { useAgentIcon } from '@renderer/lib/stores/use-agents';
import { useDefaultTaskProvider } from './use-default-task-provider';
import { publishDefaultTaskAgent, setComposerVerb, takeComposerCarry, useDefaultTaskAgent, type ComposerVerb } from '@/lib/composerVerbBridge';
import { showBesideOnScreen } from '@renderer/app/screen-layout-actions';
import { ProjectTaskComposer } from '@renderer/features/projects/components/main-panel/project-home';
import { useProjectFolderStage } from '@renderer/features/projects/components/main-panel/project-folder-stage';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { composerDrafts, projectDraftKey } from './composer-drafts';
import { cancelComposerVerb, composerVerbLook } from './composer-verb-tag';
import { ScheduleDispatchComposer } from './schedule-dispatch-composer';
import { TaskDispatchComposer } from './task-dispatch-composer';
import { shellPort } from '@renderer/lib/shell-port';
import { log } from '@renderer/utils/logger';

/** 会话输入框上「新任务 / 定时任务」记在哪一格(composerVerbBridge 按字符串记;对话用对话 id)。 */
export const sessionVerbKey = (sessionId: string) => `session:${sessionId}`;

/**
 * gugu-dev#181 ⑫「在会话里也能派」:每条会话的输入框底排那两个词。选了一个,这一框换成那件事(SessionVerbDock),
 * 框里写着的话跟过去。
 */
export function SessionComposerVerbs({ sessionId, draft, onCarried }: {
  sessionId: string;
  draft: string;
  onCarried: () => void;
}) {
  const { translate } = useSessionMessages();
  const pick = (verb: ComposerVerb) => {
    setComposerVerb(sessionVerbKey(sessionId), verb, draft);
    if (draft.trim()) onCarried();
  };
  return (
    <>
      <Button variant="ghost" size="sm" data-testid="session-verb-task" title={translate('taskDispatch.task')} onClick={() => pick('task')}>
        <DefaultTaskAgentMark />{translate('taskDispatch.task')}
      </Button>
      <Button variant="ghost" size="sm" data-testid="session-verb-schedule" title={translate('taskDispatch.schedule')} onClick={() => pick('schedule')}>
        <Clock className="size-3.5" />{translate('taskDispatch.schedule')}
      </Button>
    </>
  );
}

/** 「新任务」按钮上那枚标:新任务的框会默认选中的那个 agent 的标(没有就不画)。 */
export function DefaultTaskAgentMark() {
  const agent = useDefaultTaskAgent();
  return agent ? <PluginIcon id={agent.id} icon={agent.icon} size={14} /> : null;
}

/** 把新任务的框会默认选中的那个 agent 和它的标交给壳:群输入框上的「新任务」按钮画它(composerVerbBridge)。 */
export function DefaultTaskAgentPublisher() {
  const id = useDefaultTaskProvider();
  const icon = useAgentIcon(id ?? '');
  useEffect(() => {
    publishDefaultTaskAgent(id && icon ? { id, icon } : null);
  }, [id, icon]);
  return null;
}

/**
 * 会话输入框选了「新任务」/「定时任务」时换上来的框:新任务就是项目首页那个框(ProjectTaskComposer),建在这条会话所在的项目里,
 * 任务卡和结果落项目群(❌ 塞进眼前这条会话的记录);建好的会话拼在右边一块。定时任务是对话里那一个,卡也落项目群。
 */
export const SessionVerbDock = observer(function SessionVerbDock({ sessionId, verb, projectId, chatId }: {
  sessionId: string;
  verb: ComposerVerb;
  projectId: string;
  /** 项目群;没有项目的会话 = undefined(它就是和这个 agent 的私聊,卡落那个私聊)。 */
  chatId: string | undefined;
}) {
  const { translate } = useSessionMessages();
  const key = sessionVerbKey(sessionId);
  const dmChatId = useSessionAgentChat(chatId ? null : { projectId, sessionId });
  const cardChatId = chatId ?? dmChatId;
  if (!cardChatId) return null;
  if (verb === 'schedule') return <ScheduleDispatchComposer chatId={cardChatId} projectId={chatId ? projectId : undefined} verbKey={key} />;
  if (!chatId) {
    // gugu-dev#181 核对 #51:没有项目的会话里派 —— agent 进不了私聊(只能两个人),卡照样留在私聊里,结果回它自己的会话。
    return (
      <TaskDispatchComposer
        chatId={cardChatId}
        verbKey={key}
        placeholder={(agent) => translate('taskDispatch.placeholderNew', { agent })}
        onSessionCreated={(result) => showBesideOnScreen({ kind: 'session', projectId: result.projectId, sessionId: result.sessionId })}
      />
    );
  }
  return <SessionTaskDock projectId={projectId} verbKey={key} />;
});

/** 这条会话的 agent 和我的私聊(与对话页给它发首句同一个地址);不要 = null。 */
function useSessionAgentChat(session: { projectId: string; sessionId: string } | null): string | undefined {
  const [chatId, setChatId] = useState<string | undefined>(undefined);
  const projectId = session?.projectId;
  const sessionId = session?.sessionId;
  useEffect(() => {
    if (!projectId || !sessionId) return;
    let live = true;
    void shellPort().ensureAgentAddress({ projectId, sessionId }).then(
      (address) => { if (live) setChatId(address.chatId); },
      (error: unknown) => log.warn('resolve the session agent chat for a new task failed', { sessionId, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => { live = false; };
  }, [projectId, sessionId]);
  return chatId;
}

const SessionTaskDock = observer(function SessionTaskDock({ projectId, verbKey }: {
  projectId: string;
  verbKey: string;
}) {
  const { translate } = useSessionMessages();
  const stage = useProjectFolderStage(projectId);
  // 选词那一刻框里写着的话跟过来:要在新建框挂上(读草稿)之前放好。
  useState(() => {
    const carried = takeComposerCarry(verbKey);
    if (carried) composerDrafts.set(projectDraftKey(projectId), carried);
    return null;
  });
  return (
    <ProjectTaskComposer
      projectId={projectId}
      stage={stage}
      verb={composerVerbLook('task', { label: translate('taskDispatch.task'), onCancel: () => cancelComposerVerb(verbKey, projectDraftKey(projectId)), testId: 'task-dispatch' })}
      // 在一条会话里派:说清是交给一个新的 agent,❌ 眼前这一个。
      placeholder={(agent) => translate('taskDispatch.placeholderNew', { agent })}
      onSessionCreated={(result) => {
        setComposerVerb(verbKey, null);
        showBesideOnScreen({ kind: 'session', projectId: result.projectId, sessionId: result.sessionId });
      }}
      focusOnOpen
    />
  );
});
