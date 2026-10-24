import { UserMessageAttachments } from "./attachment.aui";
import { MAX_ATTACHMENT_BYTES } from "@gugu/session-core/session-record/contract";
import { ChatComposer, MessageProvider, formatAttachmentSize, type ComposerAttachment, type PromptEditorRef } from "@gugu/session-ui/react/components";
import { ThemeProvider } from "@gugu/session-ui/react/primitives";
import { useLocale } from "@/i18n";
import { useTheme } from "@/store/theme";
import { useMobileShell } from "@/hooks/useMobileShell";
import { createLocalSessionMentionProvider, useSessionAgentCreationTools } from "@/session/renderer/lib/chat/local-session-mention-provider";
import { useSessionMentionDrop } from "@/session/renderer/lib/chat/use-session-mention-drop";
import { translateSessionMessage } from "@/session/renderer/localization/locale-store";
import { File as FilePart } from "./file";
import { ThreadFollowupSuggestions } from "./follow-up-suggestions.aui";
import { Image } from "./image";
import { MarkdownText } from "./markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "./reasoning.aui";
import { PauseFollowProvider, ResumeFollowAtBottom } from "./thread-follow";
import { ToolFallback } from "./tool-fallback.aui";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "./tool-group.aui";
import { ComposerAboveExtras, ComposerExtras, ThreadTailExtras, useComposerPlaceholder, useComposerStop } from "./composer-extras";
import { useAuiCopy } from "./copy";
import { TooltipIconButton } from "./tooltip-icon-button";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { live } from "./elements/surfaces";
import { cn } from "@/lib/utils";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  type ToolCallMessagePartComponent,
  useAuiState,
  useAui,
} from "@assistant-ui/react";
import {
  ArrowDown as ArrowDownIcon,
  Check as CheckIcon,
  Copy as CopyIcon,
  Download as DownloadIcon,
  MoreHorizontal as MoreHorizontalIcon,
} from "@/lib/icons";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type FC,
  type PropsWithChildren,
} from "react";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; `UserMessage` can replace the user-role
 * renderer for message formats that need domain-specific normalization. The
 * remaining slots override how the assistant message renders tool calls and
 * part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  UserMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  /** 连着的思考 + 工具调用那一组;不给就是一层不折的容器(官方模板)。 */
  ChainOfThoughtGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  /** 哪些 part 归进哪一组;不给就是官方模板那一份(`DEFAULT_GROUP_BY`)。需要按 part 的名字分(比如某种 data part)时才换。 */
  groupBy?: ThreadGroupBy | undefined;
};

export type ThreadGroupBy = ComponentProps<typeof MessagePrimitive.GroupedParts>["groupBy"];

/** 官方模板的分组:思考与工具调用各自成组,外面再套一层 chain-of-thought;独立展示的工具调用不进组。 */
export const DEFAULT_GROUP_BY: ThreadGroupBy = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
});

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  autoFocus?: boolean | undefined;
  /** Touch keyboards keep Enter for a new line; the visible send control submits. */
  submitOnEnter?: boolean | undefined;
  /** Block submission while a host prepares, keeping the draft editable. */
  sendDisabled?: boolean | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

// 入场动画只给线程**有过内容之后**才追加的行。挂上那一刻已在线上的行不是新到的(换页带过来的那句),
// 空着挂上、第一批才到的也不是(那是读进来的历史:手机进运行中的任务,整段历史从透明淡入 + 上滑一遍,
// 只剩不带动画的过程头孤零零一行,owner 10-12「进去就颤两下」);重播一遍就是从透明闪出来。
// 行按位置复用(见 ThreadMessages),所以在行挂载时定一次、❌ 之后再切类(切类会重启动画)。
const ThreadMountedContext = createContext<{ current: boolean }>({ current: true });
function useEntersAnimated(): boolean {
  const mounted = useContext(ThreadMountedContext);
  const [enters] = useState(() => mounted.current);
  return enters;
}

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

// A switched thread that is still fetching its history: skeleton, not welcome.
const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    className="animate-in fade-in fill-mode-both flex flex-col gap-y-6 [animation-delay:150ms] [animation-duration:200ms]"
  >
    <span className="sr-only">Loading task</span>
    <Skeleton className="ml-auto h-9 w-2/5 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
    </div>
    <Skeleton className="ml-auto h-9 w-1/3 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-10/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
    </div>
  </div>
);

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocus = true,
  submitOnEnter = true,
  sendDisabled = false,
}) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot isEmpty={isEmpty} autoFocus={autoFocus} submitOnEnter={submitOnEnter} sendDisabled={sendDisabled} />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{ isEmpty: boolean; autoFocus: boolean; submitOnEnter: boolean; sendDisabled: boolean }> = ({
  isEmpty,
  autoFocus,
  submitOnEnter,
  sendDisabled,
}) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);
  const mounted = useRef(false);
  useEffect(() => { if (!isEmpty) mounted.current = true; }, [isEmpty]);
  const [following, setFollowing] = useState(true);
  const pauseFollow = useCallback(() => setFollowing(false), []);
  const resumeFollow = useCallback(() => setFollowing(true), []);

  return (
    <ThreadMountedContext.Provider value={mounted}>
    <PauseFollowProvider value={pauseFollow}>
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        ["--thread-max-width" as string]: "44rem",
        ["--composer-bg" as string]: "var(--color-card)",
        // @@@radius-thread (Refs #6105) — 官方默认 1.5rem(24px) 正是 design.md「a rounded-3xl composer」
        // 点名禁的那个形状。composer 与用户气泡同属 thread 档(16px)。
        ["--composer-radius" as string]: "var(--radius-thread)",
        ["--composer-padding" as string]: "8px",
      }}
    >
      {/* 跟到底(官方默认锚)。❌ turnAnchor="top":它关掉跟底,改在 isRunning 期间把用户那句钉顶,
          而手机线程的 isRunning 只算「这台手机正在发」(AgentThread),钉顶永远不生效 ⇒ 新消息沉在屏外。
          人点开 / 收起一行时暂停跟底，回到底部再恢复(thread-follow.tsx)。 */}
      <ThreadPrimitive.Viewport
        data-slot="aui_thread-viewport"
        autoScroll={following}
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <ResumeFollowAtBottom paused={!following} onResume={resumeFollow} />
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>
          <AuiIf condition={isHistoryLoadingView}>
            <ThreadHistorySkeleton />
          </AuiIf>

          <div
            data-slot="aui_message-group"
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadMessages />
            {/* 咕咕加的第三个宿主插槽:时间线末尾、在流里(待答的审批/提问卡)。 */}
            <ThreadTailExtras />
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible pb-4 md:pb-6",
              // @@@radius-page (Refs #6105) — ViewportFooter 是贴底满宽带:
              // design.md「Never round a full-bleed surface」⇒ 不带圆角。
              !isEmpty && "sticky bottom-0 mt-auto",
            )}
          >
            <ThreadScrollToBottom />
            <ThreadFollowupSuggestions />
            {/* 咕咕加的第二个宿主插槽:输入框**正上方**(发送失败)。这一带贴底、没有高度上限,
                待答的审批/提问卡 ❌ 放这里 —— 一张比视口高的卡会把整个视口盖住,见 ThreadTailExtras。 */}
            <ComposerAboveExtras />
            <Composer autoFocus={autoFocus} submitOnEnter={submitOnEnter} sendDisabled={sendDisabled} />
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
    </PauseFollowProvider>
    </ThreadMountedContext.Provider>
  );
};

const ThreadMessage: FC = () => {
  const {
    AssistantMessage: AssistantMessageComponent = AssistantMessage,
    UserMessage: UserMessageComponent = UserMessage,
  } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);

  if (role === "user") return <UserMessageComponent />;
  return <AssistantMessageComponent />;
};

const MESSAGE_COMPONENTS = { Message: ThreadMessage };

// 咕咕改的:行的 key 是从「往前补页之前的第一条」数起的位置,❌ 官方 ThreadPrimitive.Messages 的裸下标。
// 往前补进更早的一页时,裸下标会把每条已有消息挪进一个新建的行:整条线重新挂载,入场动画也重播一遍(#6952;
// 那时消息根还带着 content-visibility:auto 的 200px 占位,新行下一帧才量出真高,读者那一行跟着跳 —— 占位已去掉,
// 见 AssistantMessage)。从原来的第一条数起,补页前后已有的行 key 不变,只有新的一页是新行。末尾照旧按位置:乐观那一行被记录顶掉(换了
// id)时还是同一行,❌ 按 id 挂(那样会重挂、再淡入一遍)。第一条整个换了(记录换了世代)就从头数。
// 往前补进来的行是更早的历史,不是新到的,不播入场动画:紧挨着读者那一行上面的就在屏上,它的位移动画一结束,
// 浏览器的滚动锚定就不补偿那一帧上方行画出真高时的收缩,读者那一行照样跳(mac1 实测 −536 px)。
const HISTORY_ROW = { current: false };
const ThreadMessages: FC = () => {
  const mounted = useContext(ThreadMountedContext);
  const messages = useAuiState((s) => s.thread.messages);
  const firstId = messages[0]?.id;
  const [origin, setOrigin] = useState({ firstId, offset: 0 });
  let offset = origin.offset;
  if (origin.firstId !== firstId) {
    const prepended = messages.findIndex((message) => message.id === origin.firstId);
    offset = prepended > 0 ? origin.offset + prepended : 0;
    setOrigin({ firstId, offset });
  }
  return messages.map((_, index) => (
    <ThreadMountedContext.Provider key={index - offset} value={index < offset ? HISTORY_ROW : mounted}>
      <ThreadPrimitive.MessageByIndex index={index} components={MESSAGE_COMPONENTS} />
    </ThreadMountedContext.Provider>
  ));
};

const ThreadScrollToBottom: FC = () => {
  const c = useAuiCopy();
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip={c.scrollToBottom}
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  const c = useAuiCopy();
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
      {/*
        官方这句是 `How can I help you today?` —— 那是「开一个新对话」的口气。
        这一页是**在看别人机器上已经存在的一条会话**:空着的意思是「这条会话还没有内容」,
        不是「来跟我说点什么吧」。口气错了会让人以为自己进错了地方。
      */}
      <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-lg font-medium tracking-tight duration-200">
        {c.emptyTitle}
      </h1>
      <p className="aui-thread-welcome-hint text-muted-foreground mt-1.5 text-sm">
        {c.emptyHint}
      </p>
    </div>
  );
};

const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-wrap items-center justify-center gap-2 px-4">
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </div>
  );
};

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200">
      <SuggestionPrimitive.Trigger send asChild>
        <Button
          variant="ghost"
          className="aui-thread-welcome-suggestion text-foreground hover:bg-muted border-border/60 h-auto gap-1.5 rounded-[var(--radius-control)] border px-3.5 py-1.5 text-sm font-normal whitespace-nowrap transition-colors"
        >
          <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1" />
          <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 empty:hidden" />
        </Button>
      </SuggestionPrimitive.Trigger>
    </div>
  );
};

function Composer({ autoFocus, submitOnEnter, sendDisabled }: { autoFocus: boolean; submitOnEnter: boolean; sendDisabled: boolean }) {
  const c = useAuiCopy();
  const { resolvedLocale } = useLocale();
  const { theme } = useTheme();
  const mobile = useMobileShell();
  const composer = useAui().composer;
  const { text, attachments, isEmpty, canSend } = useAuiState((s) => s.composer);
  const { isRunning, isDisabled, capabilities } = useAuiState((s) => s.thread);
  const hostStop = useComposerStop();
  const placeholder = useComposerPlaceholder() ?? c.placeholder;
  const editor = useRef<PromptEditorRef | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const previews = useRef(new Map<File, string>());
  const { byEngine, error, renderMentionIcon } = useSessionAgentCreationTools();
  const mentionProvider = useMemo(() => createLocalSessionMentionProvider({ creationToolsByEngine: byEngine, creationToolsError: error }), [byEngine, error]);
  const { dataDropTypes, onDataDropped } = useSessionMentionDrop({ provider: mentionProvider, editorApiRef: editor });
  useEffect(() => {
    if (editor.current?.getText() !== text) editor.current?.setText(text);
  }, [text]);
  useEffect(() => { if (autoFocus) editor.current?.focus(); }, [autoFocus]);
  useEffect(() => {
    for (const [file, url] of previews.current) {
      if (!attachments.some((attachment) => attachment.file === file)) {
        URL.revokeObjectURL(url);
        previews.current.delete(file);
      }
    }
  }, [attachments]);
  useEffect(() => {
    const urls = previews.current;
    return () => { for (const url of urls.values()) URL.revokeObjectURL(url); };
  }, []);
  const chips: ComposerAttachment[] = attachments.map(({ id, name, type, status, file }) => {
    if (type === 'image' && file && !previews.current.has(file)) previews.current.set(file, URL.createObjectURL(file));
    const failed = status.type === 'incomplete';
    const progress = status.type === 'running' ? Math.floor(status.progress * 100) : undefined;
    return { id, name, kind: type === 'image' ? 'image' : 'file',
      previewUrl: file ? previews.current.get(file) : undefined,
      state: failed ? 'error' : progress !== undefined ? 'uploading' : 'done', progress,
      meta: failed ? status.message : progress !== undefined ? `${progress}%` : file ? formatAttachmentSize(file.size) : undefined,
      cancelable: true, retryable: failed && !!file && file.size <= MAX_ATTACHMENT_BYTES };
  });
  const addFiles = (files: File[]) => { for (const file of files) void composer.addAttachment(file); };
  return (
    <ThemeProvider theme={theme} target="documentElement">
      <MessageProvider locale={resolvedLocale} translate={translateSessionMessage}>
        <input ref={picker} type="file" multiple hidden onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        <ChatComposer editorApiRef={editor} mobile={mobile} placeholder={placeholder}
          editorOptions={{ enterBehavior: submitOnEnter ? 'submit' : 'newline', clearOnSubmit: false }}
          disabled={isDisabled} canSubmit={!sendDisabled && canSend && (!isRunning || capabilities.queue)}
          isWorking={!!hostStop && isEmpty} stopDisabled={hostStop?.stopping}
          onStop={hostStop?.onStop} onInputChange={(value) => composer.setText(value)} onSubmit={() => composer.send()}
          onAttach={capabilities.attachments ? () => picker.current?.click() : undefined}
          onFilesDropped={capabilities.attachments ? addFiles : undefined} onImageFilesDropped={capabilities.attachments ? addFiles : undefined}
          attachments={chips} onAttachmentsChange={(next) => { for (const attachment of attachments) if (!next.some((chip) => chip.id === attachment.id)) void composer.attachment({ id: attachment.id }).remove(); }}
          onRetryAttachment={(id) => { const file = attachments.find((attachment) => attachment.id === id)?.file; if (file) void composer.attachment({ id }).remove().then(() => composer.addAttachment(file)); }}
          toolbarExtra={<ComposerExtras />} mentionProvider={mentionProvider} renderMentionIcon={renderMentionIcon}
          dataDropTypes={dataDropTypes} onDataDropped={onDataDropped} />
      </MessageProvider>
    </ThemeProvider>
  );
}
const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

export const AssistantMessage: FC = () => {
  const c = useAuiCopy();
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
    ChainOfThoughtGroup,
    groupBy = DEFAULT_GROUP_BY,
  } = useContext(ThreadComponentsContext);

  // 行按位置复用(见 ThreadMessages):同一行可能换成另一条消息,正文按 id 重挂(❌ 留着上一条的正文)。
  const messageId = useAuiState((s) => s.message.id);
  const enters = useEntersAnimated();

  const ACTION_BAR_PT = "pt-1.5";
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;

  // ❌ content-visibility:auto + contain-intrinsic-size:官方模板带的。没画过的行先按 200px 估高,滑到 / 展开 / 新消息到达时
  // 才换成真高 ⇒ scrollHeight 在读者手底下变,画面一跳一跳(手机实测:送达一条消息,正在跑的那块一帧上跳 200px)。
  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className={cn(enters && "fade-in slide-in-from-bottom-1 animate-in duration-150", "relative -mb-7.5 pb-7.5")}
    >
      <div
        key={messageId}
        data-slot="aui_assistant-message-content"
        className="text-foreground px-2 leading-relaxed wrap-break-word"
      >
        <MessagePrimitive.GroupedParts groupBy={groupBy}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                if (ChainOfThoughtGroup) {
                  return <ChainOfThoughtGroup group={part}>{children}</ChainOfThoughtGroup>;
                }
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning": {
                if (ReasoningGroup) {
                  return (
                    <ReasoningGroup group={part}>{children}</ReasoningGroup>
                  );
                }
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running}>
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data":
                return part.dataRendererUI;
              case "file":
                return (
                  <div data-slot="aui_assistant-message-file" className="py-1">
                    <FilePart {...part} />
                  </div>
                );
              case "image":
                return (
                  <div data-slot="aui_assistant-message-image" className="py-1">
                    <Image {...part} />
                  </div>
                );
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    // @@@live-accent (Refs #6105) —— 「正在回」这一点是 streaming 态,走唯一那个 accent。
                    className={cn(live, "animate-pulse font-sans motion-reduce:animate-none")}
                    aria-label={c.running}
                  >
                    {"●"}
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  const c = useAuiCopy();
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip={c.copy}>
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip={c.more}
            className="data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              {c.exportMarkdown}
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className="py-1">
    <FilePart {...part} />
  </div>
);

const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <Image {...part} />
  </div>
);

// 咕咕没有分支、也没有重发:官方模板里的分支切换器(BranchPicker)、编辑重发、重新生成都删了。
// 消息下面冒出「‹ 2/2 ›」只会是仓库里多了一份幽灵行(#6901);上游重新拷这个文件时 ❌ 把它们带回来。
export const UserMessage: FC = () => {
  const enters = useEntersAnimated();
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className={cn(enters && "fade-in slide-in-from-bottom-1 animate-in duration-150", "grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 [&:where(>*)]:col-start-2")}
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-[var(--radius-thread)] px-4 py-2 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts
            components={{ File: UserFilePart, Image: UserImagePart }}
          />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};
