import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { getGitRepositoryStore } from '@renderer/features/projects/stores/project-selectors';
import {
  useCreateSessionCallback,
  type SessionCreationSurface,
} from '@renderer/features/sessions/create-session-modal/use-create-session-callback';
import { useCreateSessionState } from '@renderer/features/sessions/create-session-modal/use-create-session-state';
import { useProjectGitContext } from '@renderer/features/sessions/create-session-modal/use-project-git-context';
import { useSessionSettings } from '@renderer/features/sessions/hooks/useSessionSettings';
import { SessionField } from '@renderer/features/sessions/session-config/session-field';
import type { ComposerVerbLook } from '@renderer/features/sessions/session-config/initial-session-section';
import { useInitialSessionState } from '@renderer/features/sessions/session-config/initial-session-section';
import { SessionStateProvider } from '@renderer/features/sessions/session-config/session-state-context';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { ComposerProjectPicker } from './composer-context-tray';
import { describeImplicitProjectFailure, machineComposerProps } from './use-machine-create-target';
import { useNewSessionMachine } from '@renderer/features/remote-hosts/use-new-session-machine';
import { useWakeCloudOnInput } from '@renderer/features/remote-hosts/use-wake-cloud-once';
import { machineLibraryHost } from '@renderer/features/library/library-host';
import { ComposerTray } from './composer-tray';
import { useRemoteInstallBeforeCreate } from './remote-install-before-create';
import {
  ImplicitSessionHomeProjectError,
  ensureImplicitSessionHomeProjectId
} from './implicit-session-home-project';
import {
  sessionComposerFrameClassName,
  sessionComposerDockBandClassName,
  sessionComposerDockedWidthClassName
} from './session-composer-styles';
import { CreateDeliveryError } from './create-session-modal/create-delivery-error';
import { NEW_SESSION_DRAFT_KEY, composerDrafts } from './composer-drafts';
import { prepareProjectTask } from '@renderer/features/projects/project-task-entry';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

// 新建页与项目首页、会话页共用底部 composer。Project context is optional in the UI.
// The current session-page task model still requires a
// projectId internally, so an unscoped task runs in an isolated app-owned git directory; choosing a
// project replaces that internal context with the selected repository. Projectless sends stay in
// the global Tasks section; selected-project sends stay under that project.

// gugu #2549: exported so the composer-only embed root (对话页原地创建 Agent,
// app/composer-embed-root.tsx) can reuse this exact createSession input and submission path.
// gugu #2525: 上下文托盘的控件也已共用（composer-context-tray.tsx）——对话页那条托盘比这里多一个
// 设备选择器。新建页在这份共享 composer 上加标题。
export const NewSessionComposer = observer(function NewSessionComposer({
  projectId,
  blockReason,
  blocked = false,
  isContextPending,
  creationSurface,
  birthChatId,
  taskChatId,
  openAfterCreate,
  onSessionCreated,
  machine = null,
  draftKey,
  placeholder,
  verb,
  workspaceId,
}: {
  projectId: string | undefined;
  // gugu #2525: 非空 = 当前创建上下文不可提交（所选设备离线 / 非本机 / 默认值读写失败）。
  // 挡住发送 + 原样显示原因，❌ 不静默换一台设备把任务建到别处去。
  blockReason?: string | null;
  /**
   * 所选机器此刻用不了(离线 / 休眠 / 正在连…):挡住发送、草稿留着。原因由统一提示条里那台机器的一条说
   * (remote-hosts/machine-notice.ts),❌ 在这里再画一行 —— 它一变输入框就跟着动。
   */
  blocked?: boolean;
  // 默认值读取期间只挡住提交，不渲染独立状态行；真实阻塞仍由 blockReason fail loud。
  isContextPending?: boolean;
  /** 缺省 = 会话页。只有对话页/联系人页的创建草稿传 'chat-page'(见 SessionCreationSurface)。 */
  creationSurface?: SessionCreationSurface;
  /** 建出来的 agent 一出生就进这个群(对话页从群成员里点的「新建 Agent」)。 */
  birthChatId?: string;
  /** gugu-dev#181 派任务:首句落成这个对话里的一张任务卡(见 useCreateSessionCallback)。 */
  taskChatId?: string;
  /** false = 建完人留在原处、当场起它(见 useCreateSessionCallback);缺省 = 导航过去。 */
  openAfterCreate?: boolean;
  onSessionCreated?: (result: { projectId: string; sessionId: string }) => void;
  /**
   * #6264 所选机器是另一台(一套工作台:项目就是那台机器上的项目,建会话走同一条路);
   * 那台机器上还没装所选的家时,发送先在那台机器上装好(behavior gugu-server 第 6 条)。null = 本机。
   */
  machine?: { deviceId: string; label: string } | null;
  /**
   * 草稿暂存在 composerDrafts 的哪一格:挂上时读、每次改都写回、发送成功即清。
   * 缺省 = 不暂存,草稿只活在这棵组件里。
   */
  draftKey?: string;
  /** 缺省 = 通用的「发消息」提示;项目页换成它自己那句;给成函数 = 随所选 agent 变。 */
  placeholder?: string | ((agentName: string) => string);
  /** 这一框是「新任务 / 定时任务」:框换色、标签进框(gugu-dev#181)。 */
  verb?: ComposerVerbLook;
  /**
   * #7341 这个项目里从哪个文件夹开工(项目首页的文件夹卡 / 托盘上选的那一个)。
   * 缺省 = 项目根目录。只能是这个项目的文件夹 —— 不是的,主进程建会话时拒掉(fail loud)。
   */
  workspaceId?: string | null;
}) {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  const { defaultBranch, isUnborn, currentBranch, repositoryWorkspaceId } =
    useProjectGitContext(projectId);
  // Repository store warms lazily; touching it keeps parity with the project home / modal.
  if (projectId) void getGitRepositoryStore(projectId);

  const state = useCreateSessionState(
    projectId,
    defaultBranch,
    isUnborn,
    currentBranch,
    workspaceId ?? repositoryWorkspaceId,
    undefined,
    null,
    // 这个页面只有一个输入框、没有任务名输入 → 名字必须自己生成,不能受 autoGenerateName 设置摆布。
    // runInProjectDir: 会话直接跑在项目目录,不额外开 worktree(owner 定调:session 就是 task)。
    { requireGeneratedName: true, runInProjectDir: true }
  );
  const { autoApproveByDefault, includeIssueContextByDefault } = useSessionSettings();
  const initialSession = useInitialSessionState(
    projectId,
    undefined,
    autoApproveByDefault,
    {
      // Selecting or clearing an optional project must not erase text the user has already written.
      resetPromptOnProjectChange: false,
      // #4325 —— 只递创建面;附件编码由 firstTurnTransportOf 那一个表达式算出来,
      // 与正文走的是同一条。❌ 不在这里自己判一遍。
      creationSurface,
      dispatchesToChat: Boolean(taskChatId),
      initialPrompt: draftKey ? composerDrafts.get(draftKey) : '',
      initialAttachmentDraft: draftKey ? composerDrafts.attachments(draftKey) : undefined,
    }
  );
  useEffect(() => {
    if (draftKey) composerDrafts.set(draftKey, initialSession.prompt);
  }, [draftKey, initialSession.prompt]);
  useEffect(() => {
    if (!draftKey) return;
    composerDrafts.consumeAttachments(draftKey);
    return composerDrafts.registerAttachments(draftKey, initialSession.captureAttachmentDraft);
  }, [draftKey, initialSession.captureAttachmentDraft]);
  // #7199 目标是一台睡着的云电脑:开始输入才叫醒它(光打开新建框 ❌ 叫醒)。
  useWakeCloudOnInput(machine?.deviceId ?? null, `${initialSession.attachments.length}:${initialSession.prompt}`);

  const remoteInstall = useRemoteInstallBeforeCreate(machine, initialSession.provider);
  const { handleCreateSession, canCreate, messageTransportError, deliveryError } = useCreateSessionCallback({
    selectedProjectId: projectId,
    state,
    initialSession,
    navigate,
    onClose: () => {},
    onCreated: (result) => {
      // 发送即消费草稿:随后的 navigate 会卸载本组件,已发出的文本不得留在暂存里。
      if (draftKey) composerDrafts.set(draftKey, '');
      onSessionCreated?.(result);
    },
    creationSurface,
    birthChatId,
    taskChatId,
    openAfterCreate,
    beforeCreate: remoteInstall.beforeCreate,
  });
  const effectiveBlockReason = blockReason || messageTransportError;
  // 「这一轮带了内容」把附件一并算上:只有附件、没有文字也是一条真首轮(#4325)。
  const hasTurnContent =
    initialSession.prompt.trim().length > 0 || initialSession.attachments.length > 0;
  const canSend =
    canCreate &&
    !blocked &&
    !effectiveBlockReason &&
    !isContextPending &&
    !initialSession.providerError &&
    hasTurnContent &&
    !initialSession.issueContextEditorOpen;

  // 外层 wrapper 不画描边/圆角/底色(见 session-composer-styles.ts 的 sessionComposerFrameClassName):
  //    卡的形状归 session-ui 的 composerShell 一处管,这里再画一层就会在四角露出第二条线。
  return (
    <div className={sessionComposerFrameClassName}>
      <SessionStateProvider
        workspaceConfig={state.workspaceConfig}
        initialSession={initialSession}
        projectId={projectId}
        isUnborn={isUnborn}
        hasPR={false}
        includeIssueContextByDefault={includeIssueContextByDefault}
      >
          <SessionField
            placeholder={placeholder ?? translate('composer.messagePlaceholder')}
            verb={verb}
            // Permission profiles are capability-backed and apply to both task and message-page
            // creation. The surface only changes where the created session lands; it must not
            // hide the user's pre-dispatch permission choice.
            showAutoApproveToggle
            onSubmit={handleCreateSession}
            canSubmit={canSend}
          />
      </SessionStateProvider>
      {/* gugu #2525: 颜色走 --em-* arbitrary value,不用 text-foreground-destructive 这类 color key ——
          session-composer-styles.ts 里实测记过:嵌进 gugu 的会话页子树里 --color-* 家族解析为空,
          Tailwind v4 对未定义 color key 直接不出规则 → 报错文案会**无声**变成普通正文色。
          这是一条 fail-loud 提示,它的可见性本身就是功能的一部分,不能赌。 */}
      {effectiveBlockReason ? (
        <p
          role="alert"
          className="border-t border-border px-4 py-2 text-xs text-[var(--em-foreground-destructive)]"
        >
          {effectiveBlockReason}
        </p>
      ) : null}
      {blocked || effectiveBlockReason ? null : remoteInstall.note}
      <CreateDeliveryError failure={deliveryError} />
    </div>
  );
});

export const NewSessionPage = observer(function NewSessionPage({
  onSessionCreated
}: {
  onSessionCreated?: (result: { projectId: string; sessionId: string }) => void;
} = {}) {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [implicitProjectId, setImplicitProjectId] = useState<string | undefined>(undefined);
  const [implicitProjectFailure, setImplicitProjectFailure] = useState<unknown>(null);

  // An unselected project is a real first-class state, not an alias for projects[0]. Prepare the
  // hidden app-owned execution context in the background while keeping the composer editable.
  //
  // 失败原因只以**未本地化的原始值**存进 state（稳定语义码或原始 Error），文案在渲染时才映射 ——
  // 存成品句子的话，切换语言后这条已经显示出来的提示会停在旧语言上。
  useEffect(() => {
    let cancelled = false;
    void ensureImplicitSessionHomeProjectId()
      .then((projectId) => {
        if (cancelled) return;
        if (!projectId) {
          setImplicitProjectFailure(new ImplicitSessionHomeProjectError('unavailable'));
          return;
        }
        setImplicitProjectId(projectId);
        setImplicitProjectFailure(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setImplicitProjectFailure(error);
      });
    return () => {
    cancelled = true;
    };
  }, []);

  const implicitProjectError = implicitProjectFailure
    ? describeImplicitProjectFailure(implicitProjectFailure, translate)
    : null;

  const effectiveProjectId = selectedId ?? implicitProjectId;
  const openProject = (projectId: string | undefined) => {
    setSelectedId(projectId);
    if (!projectId) return;
    // gugu-dev#181 ⑩:选项目 = 去那个项目里开新任务,写好的话跟着进项目块新任务框的草稿。
    prepareProjectTask(projectId, NEW_SESSION_DRAFT_KEY);
    navigate('project', { projectId });
  };

  // 项目入口。原本是贴在输入框左上角的单项页签,现在收进通栏托盘 —— 托盘还同时承载
  // 环境与分支,信息密度换的是"发任务前一眼确认跑在哪"。
  // gugu #2525: 控件本体抽到 composer-context-tray.tsx,与对话页创建草稿共用一份
  // (规范「对话页、会话页和项目页复用同一套创建能力」)。
  // #6264 选了别的机器时,项目换成那台机器上的(在哪台机器上跑是这一条会话的属性,见 use-new-session-machine.tsx)。
  const { remote, machineContext, devicePicker, projectPicker } = useNewSessionMachine(
    <ComposerProjectPicker includeRemote selectedId={selectedId} onSelect={openProject} />
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center px-4">
        {/* 去掉入场滑入(不解释状态变化,只是每次开页都要看的表演)与 `text-xl font-semibold`
            (`.gg-type-page-title` 现在真有定义 20/28/600,别写两遍)。规格 §2 */}
        <h1 className="gg-type-page-title">
          {translate('task.newTask')}
        </h1>
      </div>
      <div className={sessionComposerDockBandClassName}>
        <div className={sessionComposerDockedWidthClassName}>
          <ComposerTray
            projectPicker={projectPicker}
            devicePicker={devicePicker}
            host={machineContext?.host ?? machineLibraryHost(null)}
          >
            <NewSessionComposer
              // 换机器 = 换一个创建目标:整棵重挂,上一台机器的选择(agent、模型)不带到下一台;
              // 写好的话经 draftKey 那一格跟着走。
              key={remote?.deviceId ?? 'local'}
              draftKey={NEW_SESSION_DRAFT_KEY}
              {...machineComposerProps(machineContext, { projectId: effectiveProjectId })}
              onSessionCreated={onSessionCreated}
            />
          </ComposerTray>
          {implicitProjectError && !selectedId ? (
            <p className="mt-3 text-center text-xs text-foreground-destructive">
              {implicitProjectError}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
});
