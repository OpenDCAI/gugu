import { translateSessionMessage } from '@renderer/localization/locale-store';
import { messageForUser } from '@/lib/userFacingError';
import { useCallback, useRef, useState } from 'react';
import { getSessionPageStore, asProvisioned, getSessionManagerStore } from '@renderer/features/sessions/stores/session-selectors';
import {
  SessionCreationFailedError,
  type SessionFailure,
} from '@renderer/features/sessions/stores/session-failure';
import type { InitialSessionState } from '@renderer/features/sessions/session-config/initial-session-section';
import { rpc, rpcOn } from '@renderer/lib/ipc';
import { getRendererSession } from '@/lib/sessionPublication';
import { machineRegistry } from '@renderer/lib/machine-routing';
import type { NavigateFnTyped } from '@renderer/lib/layout/navigation-provider';
import { log } from '@renderer/utils/logger';
import { shellPort } from '@renderer/lib/shell-port';
import { toast } from '@renderer/lib/hooks/use-toast';
import { buildInitialSession } from './build-create-session-params';
import { firstTurnTransportOf } from './first-turn-transport';
import type { TurnFileRef } from '@gugu/session-core/session-record/contract';
import { turnAttachmentText } from '@gugu/core/shared/attachmentFolderLine';
import { taskAttachmentUsesSsh, taskAttachmentWorkspacePath } from '@/lib/taskAttachmentTarget';
import type { CreateSessionState } from './use-create-session-state';

interface CreatedSession {
  projectId: string;
  sessionId: string;
}

interface PendingMessage extends CreatedSession {
  sessionId: string;
  clientMessageId: string;
  text: string;
  files?: TurnFileRef[];
}

interface UseCreateSessionCallbackParams {
  selectedProjectId: string | undefined;
  state: CreateSessionState;
  initialSession: InitialSessionState;
  navigate: NavigateFnTyped;
  onClose: () => void;
  onCreated?: (result: CreatedSession) => void;
  /** 建出来的 agent 一出生就进这个群(CreateSessionParams.birthChatId)。 */
  birthChatId?: string;
  /**
   * gugu-dev#181 派任务:这一轮由哪个对话的输入框派出。首句由宿主落成那里的一张任务卡(task-card-first-turn.ts),
   * 结果回那里。ACP 首句的附件引用由 Life 准备;PTY 卡片只放文件夹引用,不带本机路径。
   */
  taskChatId?: string;
  /**
   * 建完去不去看它。缺省 = 去(导航到会话,会话页挂上来就起它);false = 发起方留在原处(项目里、聊天里派任务),
   * 这里当场起它(startCreatedSession),会话放哪由 onCreated 决定。
   */
  openAfterCreate?: boolean;
  /** #6264 建任务之前先做的一步(别的机器上还没装所选的家:先在那台机器上装好)。失败 = 不建,原因说出来。 */
  beforeCreate?: () => Promise<void>;
}

function retainNewerInput(submitted: string, current: string): string {
  if (current === submitted) return '';
  if (current.startsWith(submitted)) return current.slice(submitted.length).replace(/^\n/, '');
  return current;
}

export function useCreateSessionCallback({
  selectedProjectId,
  state,
  initialSession,
  navigate,
  onClose,
  onCreated,
  birthChatId,
  taskChatId,
  openAfterCreate = true,
  beforeCreate,
}: UseCreateSessionCallbackParams): {
  handleCreateSession: () => void;
  canCreate: boolean;
  /**
   * @@@5173 领域语义,❌ 不是成好句的文案。成句发生在渲染边界(见 session-failure.ts 的开篇约定):
   * 这样切换语言时一条**已经显示出来的**错误会跟着变,而且这个 hook 不必持有 translator ——
   * 一旦持有,它就要求调用方套 MessageProvider,而它的 21 条既有用例都是裸渲染的。
   */
  deliveryError: SessionFailure | null;
} {
  const creatingRef = useRef(false);
  const pendingMessageRef = useRef<PendingMessage | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  // 投递失败必须说出来:未送出的正文与附件都还在 composer 里,用户看不到原因就只能猜(#4325 ③)。
  const [deliveryError, setDeliveryError] = useState<SessionFailure | null>(null);

  const submittedText = initialSession.prompt.trim();
  // 首轮的投递通道:唯一定义在 firstTurnTransportOf。
  const firstTurnTransport = firstTurnTransportOf({
    sessionView: initialSession.sessionView,
    prompt: initialSession.promptCapability,
  });
  // 「这一轮带了内容」= 有文字**或**有待发附件。纯附件也是首轮 —— 判据不看「打了字没有」。
  const pendingAttachmentCount = initialSession.attachments.length;
  const hasTurnContent = submittedText.length > 0 || pendingAttachmentCount > 0;
  const canRetry = Boolean(pendingMessageRef.current && hasTurnContent);
  // 用户改了内容之后那条失败原因就不再描述屏幕上这一轮了,留着它是在断言一件已经不成立的事。
  // ⚠️ 附件那一维读 attachmentEditSeq(只记用户的增删),❌ 不读 attachments.length —— 后者
  //    发送端自己也在改,会让最后一件的失败原因被前几件的成功抹掉(见该字段的定义处)。
  const deliveryErrorSubject = `${submittedText}\u0000${initialSession.attachmentEditSeq}`;
  const deliveryErrorSubjectRef = useRef(deliveryErrorSubject);
  if (deliveryErrorSubjectRef.current !== deliveryErrorSubject) {
    deliveryErrorSubjectRef.current = deliveryErrorSubject;
    if (deliveryError) setDeliveryError(null);
  }
  // spec session-resume:新建会话必须带首轮 —— 没有第一句话的会话在引擎侧什么都不是,
  // 重开时既恢复不了(没有历史)也重来不了(连可重来的那句话都没有)。所以这里不是「建议填」,
  // 是**建不出来**:❌ 不给用户造出一具他以后打不开的空壳。主进程的闸是第二道。
  //
  // 判据是「这一轮带了内容」,❌ 不是「打了字」:**纯图片也是首轮**,所以这里读的是 hasTurnContent。
  const canCreate = !isCreating && (
    canRetry || (
      !!selectedProjectId
      && hasTurnContent
      && state.isValid
      // 「还没选智能体」自 2026-09-17 起不再是一条错误(见 provider-selection.ts 抬头),所以这道闸
      // ❌ 不能只读 providerError —— 只读它就会在空态下放行,建出一个没有 agent 的任务。
      && !!initialSession.provider
      && !initialSession.providerError
      && !!getSessionManagerStore(selectedProjectId)
    )
  );

  const sendOrdinaryMessage = useCallback(async (message: PendingMessage): Promise<void> => {
    const result = await rpc.sessions.sendMessage({
      projectId: message.projectId,
      sessionId: message.sessionId,
      clientMessageId: message.clientMessageId,
      text: message.text,
      ...(message.files?.length ? { delivery: { queue: true as const, files: message.files } } : {}),
    });
    if (result.status === 'outcome-unknown') {
      throw new Error(`Message ${message.clientMessageId} has an outcome-unknown dispatch`);
    }
  }, []);

  const createSessionNow = useCallback((named: readonly TurnFileRef[]) => {
    if (creatingRef.current) return;

    const retry = pendingMessageRef.current;
    if (retry) {
      creatingRef.current = true;
      setIsCreating(true);
      setDeliveryError(null);
      void sendOrdinaryMessage(retry).then(
        () => {
          pendingMessageRef.current = null;
          initialSession.setPrompt((current) => retainNewerInput(retry.text, current));
          onCreated?.({ projectId: retry.projectId, sessionId: retry.sessionId });
          navigate('session', { projectId: retry.projectId, sessionId: retry.sessionId });
          onClose();
        },
        (error) => {
          setDeliveryError({
            kind: 'raw',
            detail: error instanceof Error ? error.message : String(error),
          });
          log.error('send message to created session failed', error);
        },
      ).finally(() => {
        creatingRef.current = false;
        setIsCreating(false);
      });
      return;
    }

    if (!selectedProjectId) return;
    const sessionManager = getSessionManagerStore(selectedProjectId);
    if (!sessionManager) return;
    // 权限档不在这里分面:聊天页那一面的**默认**已经由 useInitialSessionState 解析进
    // `initialSession.permissionMode`,所以 composer 上显示的就是落库的(@@@5597-draft-decides)。
    const sessionId = crypto.randomUUID();
    const baseSession = buildInitialSession(initialSession, {
      startupOrigin: 'session-page',
      id: sessionId,
    });
    if (!baseSession) return;
    const deviceId = machineRegistry.machineOf(selectedProjectId);
    const files = named.map(ref => deviceId && taskAttachmentUsesSsh(deviceId)
      ? { ...ref, path: undefined, workspacePath: taskAttachmentWorkspacePath(ref.itemId, ref.name) } : ref);
    // ACP keeps the person's words: Life prepares file context only after placement. PTY retains its text-only leg.
    const text = baseSession.type === 'acp' ? initialSession.prompt.trim() : [initialSession.prompt.trim(),
      ...named.map(ref => turnAttachmentText(ref, deviceId || !ref.path || taskChatId
        ? { failure: 'kept on the computer it was attached from — open the folder file above' }
        : { localPath: ref.path })),
    ].filter(Boolean).join('\n');
    const transport = firstTurnTransport;
    const initialMessageId = transport === 'startup' && taskChatId && text ? crypto.randomUUID() : undefined;
    const startupSession = transport === 'startup'
      ? (() => {
            const startupOrigin = 'session-page' as const;
            return baseSession.type === 'acp'
            ? {
                ...baseSession,
                startupOrigin,
                initialMessageId,
                ...(taskChatId && initialMessageId ? { taskChatId } : {}),
                initialQueue: text || files.length
                  ? [{
                      text,
                      ...(files.length ? { files } : {}),
                      ...(initialSession.mentionContext
                        ? { hiddenContext: initialSession.mentionContext }
                        : {}),
                      origin: 'manual' as const,
                    }]
                  : undefined,
              }
            : {
                ...baseSession,
                startupOrigin,
                initialMessageId,
                ...(taskChatId && initialMessageId ? { taskChatId } : {}),
                initialPrompt: text || undefined,
              };
        })()
      : baseSession;
    const session = startupSession;
    const message = (text || pendingAttachmentCount > 0) && transport === 'local-session'
      ? {
          projectId: selectedProjectId,
          sessionId,
          clientMessageId: crypto.randomUUID(),
          text,
          ...(baseSession.type === 'acp' && files.length ? { files } : {}),
        } satisfies PendingMessage
      : null;
    const resolvedWorkspaceConfig = state.workspaceConfig.resolvedConfig;
    if (!resolvedWorkspaceConfig) {
      throw new Error(`project ${selectedProjectId} has no workspace to run this session in`);
    }
    const createInput = {
      projectId: selectedProjectId,
      sessionConfig: {
        version: '1' as const,
        name: state.sessionName.effectiveSessionName,
        linkedIssue: state.linkedType === 'issue' ? (state.linkedIssue ?? undefined) : undefined,
        initialSession: session,
      },
      workspaceConfig: resolvedWorkspaceConfig,
      // 对话里派的新任务(taskChatId)进群坐任务座位:不发入群提示;群成员里「新建 Agent」照常提示。
      ...(birthChatId ? { birthGroup: { chatId: birthChatId, asTask: Boolean(taskChatId) } } : {}),
    };

    const deferFirstTurn = baseSession.type === 'acp' && files.length > 0;
    creatingRef.current = true;
    setIsCreating(true);
    setDeliveryError(null);
    // #6264 别的机器上还没装所选的家:先在那台机器上装好再建(装不上就不建,原因说出来)。
    void (beforeCreate ? beforeCreate() : Promise.resolve()).then(() => sessionManager.createSession(createInput, deferFirstTurn ? { deferFirstTurn: true } : undefined)).then(async () => {
      // The new-session memory never stands in the way (L11 复核 58): the session is made, its first line sent and the
      // box closed even when this computer cannot save what was picked — said in the log and in a light notice. Written
      // once the session exists, not awaited: a first line that fails still leaves a started session to remember, so its
      // retry needs no second write.
      void initialSession.rememberStartedConfiguration().catch((error: unknown) => {
        log.error('remember the started configuration failed', { error: error instanceof Error ? error.message : String(error) });
        toast({ title: translateSessionMessage('task.newSessionMemoryNotSaved'), description: messageForUser(error), tier: 'warning' });
      });
      // The first ACP turn stays deferred until DM placement (including SSH upload) has finished.
      try {
        if (named.length > 0) {
          const placed = await initialSession.placeAttachments(async () => {
            const owner = getRendererSession()?.user.id;
            if (!owner) throw new Error('attachments: not signed in');
            return { chatId: (await shellPort().ensureAgentAddress({ projectId: selectedProjectId, sessionId })).chatId, owner, sessionId,
              deviceId: machineRegistry.machineOf(selectedProjectId), projectId: selectedProjectId,
              workspaceId: asProvisioned(getSessionPageStore(selectedProjectId, sessionId))?.workspaceId };
          });
          // ❌ 不 throw:任务已经建好,重试那条路会再建一个。没放成的那几件在日志与提示里说出来。
          if (!placed) {
            log.warn('new task attachments were not all placed in the agent folder', { sessionId });
            toast({ title: translateSessionMessage('composer.attachmentUploadFailed'), tier: 'warning' });
          }
          for (const { id } of initialSession.pendingAttachmentFiles()) initialSession.dropAttachment(id);
        }
      } catch (error) {
        log.warn('new task attachment placement failed', { sessionId, error: String(error) });
        toast({ title: translateSessionMessage('composer.attachmentUploadFailed'), tier: 'warning' });
      } finally {
        // Placement errors still admit the caption; the host gives the agent a not-saved line for each missing file.
        if (deferFirstTurn) await rpcOn(deviceId ?? null).sessionCreate.admitFirstMessages(sessionId);
      }
      if (message) {
        pendingMessageRef.current = message;
        await sendOrdinaryMessage(message);
        pendingMessageRef.current = null;
        initialSession.setPrompt((current) => retainNewerInput(message.text, current));
      }
      onCreated?.({ projectId: selectedProjectId, sessionId });
      if (openAfterCreate) navigate('session', { projectId: selectedProjectId, sessionId: sessionId });
      else {
        void rpcOn(machineRegistry.machineOf(selectedProjectId) ?? null).sessionTimeline.sessionStart({ conversationId: sessionId }).then((started) => {
          if (!started.ok) log.warn('start a session nobody opens failed', { sessionId, error: started.error });
        });
      }
      onClose();
    }).catch((error) => {
      // @@@5173 已知的建任务失败带着领域语义过来 ⇒ 成句在这里发生,给用户看的是产品文案。
      // ❌ 别再把 `createSession failed: <type>` 这种开发者诊断串铺给用户 —— 那条路上文案分岔
      // (「正在被替换,稍后重试」vs「没装,去装」)会被整个抹平成同一句看不懂的话。
      //
      // ⚠️ 引擎不可用是唯一的例外:它已经由 project-sessions-store 用右下角的瞬时通知说过了(owner 定的形态)。
      // 这里再挂一条常驻的红字就是同一件事说两遍 —— ❌ 别把它加回来。
      const failure: SessionFailure = error instanceof SessionCreationFailedError
        ? error.failure
        : { kind: 'raw', detail: error instanceof Error ? error.message : String(error) };
      if (failure.kind !== 'harness-unavailable') setDeliveryError(failure);
      log.error(pendingMessageRef.current ? 'send message to created session failed' : 'create session failed', error);
    }).finally(() => {
      creatingRef.current = false;
      setIsCreating(false);
    });
  }, [
    selectedProjectId,
    beforeCreate,
    birthChatId,
    taskChatId,
    openAfterCreate,
    state,
    initialSession,
    firstTurnTransport,
    pendingAttachmentCount,
    sendOrdinaryMessage,
    onCreated,
    navigate,
    onClose,
  ]);

  const handleCreateSession = useCallback(() => {
    if (creatingRef.current) return;
    const pathAttachments = !pendingMessageRef.current && pendingAttachmentCount > 0;
    if (!pathAttachments) { createSessionNow([]); return; }
    // 先给附件定名(首轮正文要写它们),再建。定不了名(不是桌面)就不建,原因说出来。
    creatingRef.current = true;
    setIsCreating(true);
    void initialSession.prepareAttachments().then(
      (named) => {
        creatingRef.current = false;
        setIsCreating(false);
        if (!named) {
          setDeliveryError({ kind: 'raw', detail: 'Attachments of a new task are placed from a desktop' });
          return;
        }
        createSessionNow(named);
      },
      (error: unknown) => {
        creatingRef.current = false;
        setIsCreating(false);
        setDeliveryError({ kind: 'raw', detail: error instanceof Error ? error.message : String(error) });
      },
    );
  }, [createSessionNow, initialSession, pendingAttachmentCount]);

  return { handleCreateSession, canCreate, deliveryError };
}
