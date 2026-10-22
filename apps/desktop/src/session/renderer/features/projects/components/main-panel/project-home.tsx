import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { focusSessionComposer } from '@renderer/features/sidebar/session-keyboard-nav';
import { getProjectStore, projectViewKind } from '@renderer/features/projects/stores/project-selectors';
import { machineLibraryHost } from '@renderer/features/library/library-host';
import { ComposerProjectPicker } from '@renderer/features/sessions/composer-context-tray';
import { ComposerTray } from '@renderer/features/sessions/composer-tray';
import { NewSessionComposer } from '@renderer/features/sessions/new-session-page';
import { NEW_SESSION_DRAFT_KEY, composerDrafts, projectDraftKey } from '@renderer/features/sessions/composer-drafts';
import { machineComposerProps } from '@renderer/features/sessions/use-machine-create-target';
import {
  sessionComposerDockBandClassName,
  sessionComposerDockedWidthClassName,
} from '@renderer/features/sessions/session-composer-styles';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { ComposerFolderPicker } from './composer-folder-picker';
import { ProjectDeviceScopePicker } from './project-device-scope';
import { useProjectFolderStage, type ProjectFolderStage } from './project-folder-stage';
import { prepareProjectTask } from '@renderer/features/projects/project-task-entry';
import { composerVerbLook } from '@renderer/features/sessions/composer-verb-tag';
import type { ComposerVerbLook } from '@renderer/features/sessions/session-config/initial-session-section';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/**
 * 项目首页(product spec「项目首页」,#7341):上面是这个项目的文件夹卡,下面是输入框
 * (owner 2026-10-17 从三个方向里选 B,取代「居中一句欢迎语 + 输入框」;那句话挪进输入框当提示)。
 * 卡片上点中的文件夹 = 新会话从哪开工,与托盘上的文件夹选择器是同一个选择。
 * 这一页只能开新任务(gugu-dev#181 ⑧):框就是「新任务」的样子,标签不带 ×。
 */
export const ProjectHome = observer(function ProjectHome({ projectId }: { projectId: string }) {
  const { translate } = useSessionMessages();
  const stage = useProjectFolderStage(projectId);
  // 上面是文件夹卡(在剩下的空间里居中,上方留出摊开的余地),输入框贴在底部 —— 与会话页聊天的输入框
  // 同一个位置、同样宽(product spec「项目首页」)。项目块的「+」只列群文件夹和 App(gugu-dev#181),
  // 终端、浏览器归会话,所以这里没有发第一句之前的草稿工作区。
  return (
      <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">

        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 pt-24 pb-6">
          {stage.card}
        </div>

        <ProjectTaskComposer
          projectId={projectId}
          stage={stage}
          verb={composerVerbLook('task', { label: translate('taskDispatch.task') })}
          placeholder={translate('projects.home.hero', { projectName: stage.displayName })}
        />
      </div>
  );
});

/**
 * 在项目里开新任务的那个框:托盘(项目 · 设备 · 文件夹)+ 新建框。项目首页摆着它;群里已有消息时,项目块里点「新任务」
 * 换上来的也是它(gugu-dev#181 ⑦ ⑧ 同一个样子),❌ 另画一份。
 * 输入框是新建任务页那一个(托盘 + NewSessionComposer):首句落成项目群里的一张任务卡,发完人留在项目块里。
 */
export const ProjectTaskComposer = observer(function ProjectTaskComposer({
  projectId,
  stage,
  verb,
  placeholder,
  onSessionCreated,
  focusOnOpen = false,
}: {
  projectId: string;
  stage: ProjectFolderStage;
  /** 换上来就把光标放进框里(群里 / 会话里点了「新任务」):直接打字就是在写这件任务。 */
  focusOnOpen?: boolean;
  verb: ComposerVerbLook;
  placeholder: string | ((agentName: string) => string);
  onSessionCreated?: (result: { projectId: string; sessionId: string }) => void;
}) {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  // gugu #2328: bootstrapping 阶段页面已上屏,发送/设置由 mounted 态解锁;这行小字是
  // 发送暂不可用的唯一提示(安静补齐,❌ 显眼 loading)。
  const isBootstrapping = projectViewKind(getProjectStore(projectId)) === 'bootstrapping';
  const { rowId, scope, scopedFolders, targetProjectId, machineContext, projectMachines, machineOfProject, pickAndAttach } = stage;
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOnOpen && boxRef.current) focusSessionComposer(boxRef.current);
  }, [focusOnOpen]);

  // 在托盘里换一个项目 = 去那个项目里开新任务,写好的话跟着走(那边还没有草稿时)。
  const openProject = (nextId: string | undefined) => {
    if (nextId === projectId) return;
    if (!nextId) {
      composerDrafts.moveToEmpty(projectDraftKey(projectId), NEW_SESSION_DRAFT_KEY);
      navigate('new-session');
      return;
    }
    prepareProjectTask(nextId, projectDraftKey(projectId));
    navigate('project', { projectId: nextId });
  };
  return (
        <div className={sessionComposerDockBandClassName}>
        <div ref={boxRef} className={sessionComposerDockedWidthClassName} data-testid="project-home-composer">
          {/* 与新建会话页同一个托盘 + 新建框(owner 2026-09-25:「也用 create task 的那个设计」):
              项目预选这一个;机器跟着选中的文件夹走(#7341 第二步:文件夹可以在别的机器上)。 */}
          <ComposerTray
            projectPicker={<ComposerProjectPicker includeRemote selectedId={rowId} onSelect={openProject} />}
            devicePicker={<ProjectDeviceScopePicker machines={projectMachines} selected={scope.selected} onSelect={scope.select} />}
            folderPicker={
              <ComposerFolderPicker
                folders={scopedFolders}
                machineLabelOf={(id) => machineOfProject(id).label}
                showMachine={projectMachines.length > 1}
                onAttach={() => pickAndAttach(machineRegistry.machineOf(targetProjectId))}
              />
            }
            host={machineContext?.host ?? machineLibraryHost(null)}
          >
            <NewSessionComposer
              // 换项目 = 换一个创建目标:整棵重挂;写好的话按项目暂存(挂载失败换成错误面板再回来也还在)。
              // 选了别的机器上的文件夹 = 换了创建目标(那台机器上的本地项目):同样整棵重挂;草稿按这一页暂存,跟着走。
              key={targetProjectId}
              draftKey={projectDraftKey(projectId)}
              // gugu-dev#181 在项目里派任务:首句落成项目群里的一张任务卡,发完人留在项目块里(点卡把会话拼到右边)。
              taskChatId={projectGroupsStore.chatIdOf(targetProjectId)}
              openAfterCreate={false}
              placeholder={placeholder}
              verb={verb}
              workspaceId={scopedFolders.chosen?.workspaceId ?? null}
              onSessionCreated={onSessionCreated}
              {...machineComposerProps(machineContext, { projectId: targetProjectId, isContextPending: scopedFolders.folders === null, blockReason: scopedFolders.folders?.length === 0 ? translate('projects.folders.scopeUnavailable') : null })}
            />
          </ComposerTray>
          {isBootstrapping && (
            <p className="mt-2 px-1 text-tiny text-foreground-passive">
              {translate('projects.home.connecting')}
            </p>
          )}
        </div>
        </div>
  );
});
