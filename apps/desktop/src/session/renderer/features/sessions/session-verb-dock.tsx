import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { Clock, Sparkles } from '@/lib/icons';
import { setComposerVerb, takeComposerCarry, type ComposerVerb } from '@/lib/composerVerbBridge';
import { showBesideOnScreen } from '@renderer/app/screen-layout-actions';
import { ProjectTaskComposer } from '@renderer/features/projects/components/main-panel/project-home';
import { useProjectFolderStage } from '@renderer/features/projects/components/main-panel/project-folder-stage';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { composerDrafts, projectDraftKey } from './composer-drafts';
import { composerVerbLook } from './composer-verb-tag';
import { ScheduleDispatchComposer } from './schedule-dispatch-composer';

/** 会话输入框上「新任务 / 定时任务」记在哪一格(composerVerbBridge 按字符串记;对话用对话 id)。 */
export const sessionVerbKey = (sessionId: string) => `session:${sessionId}`;

/**
 * gugu-dev#181 ⑫「在会话里也能派」:项目里一条会话的输入框底排那两个词。选了一个,这一框换成那件事(SessionVerbDock),
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
        <Sparkles className="size-3.5" />{translate('taskDispatch.task')}
      </Button>
      <Button variant="ghost" size="sm" data-testid="session-verb-schedule" title={translate('taskDispatch.schedule')} onClick={() => pick('schedule')}>
        <Clock className="size-3.5" />{translate('taskDispatch.schedule')}
      </Button>
    </>
  );
}

/**
 * 会话输入框选了「新任务」/「定时任务」时换上来的框:新任务就是项目首页那个框(ProjectTaskComposer),建在这条会话所在的项目里,
 * 任务卡和结果落项目群(❌ 塞进眼前这条会话的记录);建好的会话拼在右边一块。定时任务是对话里那一个,卡也落项目群。
 */
export const SessionVerbDock = observer(function SessionVerbDock({ sessionId, verb, projectId, chatId }: {
  sessionId: string;
  verb: ComposerVerb;
  projectId: string;
  /** 项目群。 */
  chatId: string;
}) {
  const key = sessionVerbKey(sessionId);
  const close = () => setComposerVerb(key, null);
  if (verb === 'schedule') return <ScheduleDispatchComposer chatId={chatId} projectId={projectId} verbKey={key} />;
  return <SessionTaskDock projectId={projectId} verbKey={key} onClose={close} />;
});

const SessionTaskDock = observer(function SessionTaskDock({ projectId, verbKey, onClose }: {
  projectId: string;
  verbKey: string;
  onClose: () => void;
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
      verb={composerVerbLook('task', { label: translate('taskDispatch.task'), onCancel: onClose, testId: 'task-dispatch' })}
      placeholder={(agent) => translate('taskDispatch.placeholder', { agent })}
      onSessionCreated={(result) => {
        onClose();
        showBesideOnScreen({ kind: 'session', projectId: result.projectId, sessionId: result.sessionId });
      }}
      focusOnOpen
    />
  );
});
