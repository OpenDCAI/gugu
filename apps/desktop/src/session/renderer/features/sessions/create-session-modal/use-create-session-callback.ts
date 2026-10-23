import { useCallback, useRef, useState } from 'react';
import { getSessionManagerStore } from '@renderer/features/sessions/stores/session-selectors';
import {
  SessionCreationFailedError,
  type SessionFailure,
} from '@renderer/features/sessions/stores/session-failure';
import type { InitialSessionState } from '@renderer/features/sessions/session-config/initial-session-section';
import { rpc, rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { shellPort } from '@renderer/lib/shell-port';
import type { NavigateFnTyped } from '@renderer/lib/layout/navigation-provider';
import { log } from '@renderer/utils/logger';
import { toast } from '@renderer/lib/hooks/use-toast';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { sessionpageLegOfView } from '@shared/core/sessions/sessions';
import type { SessionpageAgentAddress } from '@shared/sessionpage-message-host';
import { sessionpageMessageHost } from '@renderer/lib/sessionpage-message-host';
import { buildInitialSession } from './build-create-session-params';
import {
  firstTurnTransportOf,
  requireStartupOrigin,
  strayChatAttachmentError,
  type FirstTurnTransport,
  type SessionCreationSurface,
} from './first-turn-transport';
import type { CreateSessionState } from './use-create-session-state';
import { afterPathAttachmentsSettle } from './after-path-attachments-settle';

interface CreatedSession {
  projectId: string;
  sessionId: string;
}

interface PendingMessage extends CreatedSession {
  sessionId: string;
  clientMessageId: string;
  text: string;
  transport: 'router' | 'local-session';
}

export type { SessionCreationSurface } from './first-turn-transport';

interface UseCreateSessionCallbackParams {
  selectedProjectId: string | undefined;
  state: CreateSessionState;
  initialSession: InitialSessionState;
  navigate: NavigateFnTyped;
  onClose: () => void;
  onCreated?: (result: CreatedSession) => void;
  /** 缺省 = 会话页:这是产品里绝大多数创建面,也是「不把人送去聊天页」的安全默认。 */
  creationSurface?: SessionCreationSurface;
  /** 建出来的 agent 一出生就进这个群(CreateSessionParams.birthChatId)。 */
  birthChatId?: string;
  /**
   * gugu-dev#181 派任务:这一轮由哪个对话的输入框派出。首句由宿主落成那里的一张任务卡(task-card-first-turn.ts),
   * 结果回那里。只对会话页那一面成立:首句是 spawn 的启动载荷,附件是会话内的路径 mention。
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

function ensureAgentAddress(message: PendingMessage): Promise<SessionpageAgentAddress> {
  return shellPort().ensureAgentAddress({
    projectId: message.projectId,
    sessionId: message.sessionId,
  });
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
  creationSurface = 'session-page',
  birthChatId,
  taskChatId,
  openAfterCreate = true,
  beforeCreate,
}: UseCreateSessionCallbackParams): {
  handleCreateSession: () => void;
  canCreate: boolean;
  messageTransportError: string | null;
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

  const surface = sessionpageLegOfView(initialSession.sessionView);
  const submittedText = initialSession.prompt.trim();
  // 首轮的投递通道:唯一定义在 firstTurnTransportOf,附件通道读的是同一个表达式(#4325)。
  const firstTurnTransport = firstTurnTransportOf({
    creationSurface,
    sessionpage: initialSession.sessionpage,
    sessionView: initialSession.sessionView,
    prompt: initialSession.promptCapability,
  });
  // 「这一轮带了内容」= 有文字**或**有待发附件。纯附件也是首轮 —— 判据不看「打了字没有」。
  const pendingAttachmentCount = initialSession.attachments.length;
  const hasTurnContent = submittedText.length > 0 || pendingAttachmentCount > 0;
  // ⚠️ 这道闸读的必须是 hasTurnContent,不是 submittedText:只带附件、没打字的一轮若被放行,
  // transport='none' 会让下面的 message 为 null —— task 建了、附件一个字都没发、还不报错。
  // 那正是本票要判死的静默丢。
  //
  // #4658 ②:这一格若自述了关闭原因(`sessionpage[surface].reason`),原样接在通用错误后面 ——
  // 「no … message transport」只说「收不了」,reason 说「为什么」。缺席就退回裸的通用句(现存所有
  // 家皆如此,不回归)。裸串拼接,与本行本就是裸英文的文风一致(本地化归 task-workflows-localization)。
  const closureReason = initialSession.sessionpage?.[surface]?.reason;
  const messageTransportError =
    // 还没选智能体 = 还没选(发送键本来就灰着),❌ 冒一句「Provider 'unknown' …」(那不是用户造成的状态)。
    hasTurnContent && initialSession.provider && creationSurface === 'chat-page' && firstTurnTransport === 'none'
      ? `Provider '${initialSession.provider}' has no ${surface} message transport`
        + (closureReason ? `. ${closureReason}` : '')
      : null;
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
  // 判据是「这一轮带了内容」,❌ 不是「打了字」:**纯图片也是首轮**。#4325 之后附件是自己的
  // 通道(chat-page 的附件不再写进 prompt),所以这里读的是 hasTurnContent 而不是 submittedText。
  const canCreate = !isCreating && !messageTransportError && (
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
    if (message.transport === 'local-session') {
      // 重试那条路直接进这里,所以 tripwire 这一侧也要有(判据本身在 first-turn-transport)。
      const stray = strayChatAttachmentError(message.transport, initialSession.pendingAttachmentFiles(), creationSurface);
      if (stray) throw new Error(stray);
      const result = await rpc.sessions.sendMessage({
        projectId: message.projectId,
        sessionId: message.sessionId,
        clientMessageId: message.clientMessageId,
        text: message.text,
      });
      if (result.status === 'outcome-unknown') {
        throw new Error(`Message ${message.clientMessageId} has an outcome-unknown dispatch`);
      }
      return;
    }

    const address = await ensureAgentAddress(message);
    const host = sessionpageMessageHost();
    // 附件先于正文,与 exact Agent/DM 建成之后的顺序一致。每一件都由 composer 在它**真的落库**
    // 之后才移走,所以一次部分失败之后,重试只补屏幕上还剩的那几件(#4325 ③)。
    const pendingAttachments = initialSession.pendingAttachmentFiles();
    if (pendingAttachments.length > 0) {
      await host.sendAttachmentsToChat(address.chatId, pendingAttachments, {
        toUserIds: [address.agentUserId],
        onSent: (id) => initialSession.dropAttachment(id),
      });
    }
    if (message.text) {
      await host.sendMessageToChat(address.chatId, message.text, {
        toUserIds: [address.agentUserId],
        clientMessageId: message.clientMessageId,
      });
    }
    // 对话页创建的收尾就是「原地进入这个 Agent 的私聊」。会话页永远到不了这一行:
    // 它的首轮根本不走这条路(上面 transport 就分开了)。
    host.openAgentChat(address);
  }, [creationSurface, initialSession]);

  const createSessionNow = useCallback(() => {
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

    if (!selectedProjectId || messageTransportError) return;
    const sessionManager = getSessionManagerStore(selectedProjectId);
    if (!sessionManager) return;
    // 权限档不在这里分面:聊天页那一面的**默认**已经由 useInitialSessionState 解析进
    // `initialSession.permissionMode`,所以 composer 上显示的就是落库的(@@@5597-draft-decides)。
    // ⚠️ id 不在这里现造:path-mention 通道的附件在用户点「创建」**之前**就已经按这个 id
    // 落进了 `<userData>/task-attachments/<conversationId>/`,首轮正文里那条 mention 指的就是那儿
    // (#5269)。这里另造一个的话,字节和会话当场分家。没有附件时它就是一个普通的新 UUID。
    const sessionId = initialSession.reserveSessionId();
    const baseSession = buildInitialSession(initialSession, {
      startupOrigin: creationSurface,
      id: sessionId,
    });
    if (!baseSession) return;
    // path-mention 通道的附件在屏幕上是 chip,到达 agent 的路是**这一句正文里的绝对路径**
    // (#5269)。拼在这里而不是在用户打字时插进编辑器:composer 上不该出现传输用的路径 pill。
    // chat-attachment 轮的 `pathAttachmentMentions()` 恒为空,所以这一行对它是恒等的。
    const text = [initialSession.prompt.trim(), ...initialSession.pathAttachmentMentions()]
      .filter((part) => part.length > 0)
      .join('\n');
    // startup 的意思是**把这一轮的首句交给 spawn**。纯附件的一轮没有首句可交:它的第一条消息就是那条
    // attachment 行,而 attachment 行本来就是一条普通 DM 行、由读者在会话 live 之后投递。所以这一轮
    // 不该认领那个例外 —— 认领了就会既发不出附件(startup 分支不走普通发送)、又让注入器等一份不存在的
    // 载荷(`chat-page first spawn … without its first-turn payload`),结果是**建出一个起不来的 agent**。
    // ⚠️ 附件通道不受这一步影响:`attachmentChannelOf` 对 chat-page 的 startup 与 router 同答
    // chat-attachment,所以 composer 那一侧算出的 chip 归属与这里逐字一致,不会漂开(#5049)。
    const transport: FirstTurnTransport =
      firstTurnTransport === 'startup' && creationSurface === 'chat-page' && !text
        ? 'router'
        : firstTurnTransport;
    if (taskChatId && creationSurface !== 'session-page') {
      throw new Error('a dispatched task is created on the session-page surface (its first turn is the startup payload)');
    }
    // 派出去的任务首句同样是一条真的咕咕消息(那张卡),要稳定 id;没有首句可交(纯附件)就没有卡。
    const initialMessageId = transport === 'startup' && (creationSurface === 'chat-page' || (taskChatId && text))
      ? crypto.randomUUID()
      : undefined;
    // tripwire 必须在 createSession **之前**响,理由见 strayChatAttachmentError 的注释。
    const stray = strayChatAttachmentError(transport, initialSession.pendingAttachmentFiles(), creationSurface);
    if (stray) { setDeliveryError({ kind: 'raw', detail: stray }); return; }
    // 纯附件的一轮同样要有 PendingMessage:它是「这一轮还没送完」的载体,重试靠它。
    const startupSession = transport === 'startup'
      ? (() => {
            const startupOrigin = requireStartupOrigin(baseSession.startupOrigin);
            return baseSession.type === 'acp'
            ? {
                ...baseSession,
                startupOrigin,
                initialMessageId,
                ...(taskChatId && initialMessageId ? { taskChatId } : {}),
                initialQueue: text
                  ? [{
                      text,
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
    const message = (text || pendingAttachmentCount > 0) && transport !== 'none' && transport !== 'startup'
      ? {
          projectId: selectedProjectId,
          sessionId,
          clientMessageId: crypto.randomUUID(),
          text,
          transport,
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
      // 对话里派的新任务(taskChatId)进群坐任务座位:被动、不发入群提示;群成员里「新建 Agent」主动入群。
      ...(birthChatId ? { birthGroup: { chatId: birthChatId, asTask: Boolean(taskChatId) } } : {}),
    };

    creatingRef.current = true;
    setIsCreating(true);
    setDeliveryError(null);
    // #6264 别的机器上还没装所选的家:先在那台机器上装好再建(装不上就不建,原因说出来)。
    void (beforeCreate ? beforeCreate() : Promise.resolve()).then(() => sessionManager.createSession(createInput)).then(async () => {
      // The new-session memory never stands in the way (L11 复核 58): the session is made, its first line sent and the
      // box closed even when this computer cannot save what was picked — said in the log and in a light notice. Written
      // once the session exists, not awaited: a first line that fails still leaves a started session to remember, so its
      // retry needs no second write.
      void initialSession.rememberStartedConfiguration().catch((error: unknown) => {
        log.warn('remember the started configuration failed', { error: error instanceof Error ? error.message : String(error) });
        toast({ title: translateSessionMessage('task.newSessionMemoryNotSaved'), tier: 'warning' });
      });
      // 字节早就落好了,库里那一行要等会话真的存在(外键)。补登记失败不阻断这一轮:附件照样
      // 到得了 agent(mention 指的是盘上那个真文件),只是少一行记录 —— 那种目录下次启动会被
      // `sweepOrphanSessionAttachmentDirectories` 按「库里有没有这条会话」判成有主,不会被误清。
      const stagedAttachments = initialSession.pathAttachmentEntries();
      if (stagedAttachments.length > 0) {
        const recorded = await rpc.sessionCreate.recordAttachments(sessionId, stagedAttachments);
        if (!recorded.success) {
          log.warn('record session attachments failed', { sessionId, error: recorded.error });
        }
      }
      if (message) {
        pendingMessageRef.current = message;
        await sendOrdinaryMessage(message);
        pendingMessageRef.current = null;
        initialSession.setPrompt((current) => retainNewerInput(message.text, current));
      }
      if (creationSurface === 'chat-page' && transport === 'startup') {
        // The startup envelope is built by the trusted session-page injector after the agent/DM is
        // provisioned; the first text is NOT sent through the ordinary message API a second time.
        // Its attachments, however, are real attachment rows of that same DM (spec agent-create
        // 「附件与承载它的那条消息同路」, #5049): they ride the one ordinary chat send with an empty
        // text — attachments first, nothing to say after — which also resolves the address and
        // opens the chat, and stays in pendingMessageRef so a partial failure retries only the
        // files still on screen instead of creating a second Agent.
        const followUp: PendingMessage = {
          projectId: selectedProjectId,
          sessionId,
          clientMessageId: crypto.randomUUID(),
          text: '',
          transport: 'router',
        };
        pendingMessageRef.current = followUp;
        await sendOrdinaryMessage(followUp);
        pendingMessageRef.current = null;
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
    messageTransportError,
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
    if (!creatingRef.current) afterPathAttachmentsSettle(initialSession, creatingRef, setIsCreating, createSessionNow);
  }, [initialSession, createSessionNow]);

  return { handleCreateSession, canCreate, messageTransportError, deliveryError };
}
