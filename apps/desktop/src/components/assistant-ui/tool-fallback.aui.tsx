import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { memo, useCallback, useState } from "react";
import {
  AlertCircle as AlertCircleIcon,
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  XCircle as XCircleIcon,
  Wrench as WrenchIcon,
} from "@/lib/icons";
import {
  toolApprovalAcceptsText,
  useToolCallElapsed,
  type ToolApprovalOption,
  type ToolCallMessagePart,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { cn } from "@/lib/utils";
import { live } from "./elements/surfaces";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { approvalOptionLabels, useAuiCopy, type AuiCopy } from "./copy";
import { usePauseFollow } from "./thread-follow";

const ANIMATION_DURATION = 200;

const pressable = "active:scale-[0.98]";

export type ToolFallbackRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolFallbackRootProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const pauseFollow = usePauseFollow();
  const handleOpenChange = useCallback(
    (open: boolean) => {
      // 人点开 / 收起 = 暂停跟随底部(thread-follow.tsx)。
      pauseFollow();
      if (!isControlled) {
        setUncontrolledOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [isControlled, controlledOnOpenChange, pauseFollow],
  );

  return (
    <Collapsible
      data-slot="tool-fallback-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "aui-tool-fallback-root group/tool-fallback-root w-full",
        className,
      )}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      {children}
    </Collapsible>
  );
}

type ToolStatus = ToolCallMessagePartStatus["type"];

const statusIconMap: Record<ToolStatus, React.ElementType> = {
  running: WrenchIcon,
  complete: CheckIcon,
  incomplete: XCircleIcon,
  "requires-action": AlertCircleIcon,
};

const formatToolDuration = (ms: number) => {
  if (ms < 1000) return "<1s";
  const seconds = ms / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
};

function ToolFallbackDuration({
  className,
  ...props
}: React.ComponentProps<"span">) {
  const elapsedMs = useToolCallElapsed();
  if (elapsedMs === undefined) return null;

  return (
    <span
      data-slot="tool-fallback-duration"
      className={cn(
        "aui-tool-fallback-duration text-muted-foreground text-xs tabular-nums",
        className,
      )}
      {...props}
    >
      {formatToolDuration(elapsedMs)}
    </span>
  );
}

function ToolFallbackTrigger({
  toolName,
  preview,
  status,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  /** provider 给的一句入参短描述,写在名字后面。照 orca 的 `▸ 工具名 <预览>`。 */
  preview?: string;
  status?: ToolCallMessagePartStatus;
}) {
  const c = useAuiCopy();
  const statusType = status?.type ?? "complete";
  const isRunning = statusType === "running";
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";

  const Icon = statusIconMap[statusType];

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      className={cn(
        "aui-tool-fallback-trigger group/trigger text-muted-foreground hover:text-foreground flex w-full max-w-full min-w-0 origin-left items-center gap-2 py-1.5 text-sm transition-[color,scale] active:scale-[0.98]",
        className,
      )}
      {...props}
    >
      {isRunning ? <span data-slot="tool-fallback-trigger-icon" className={cn("aui-tool-fallback-trigger-icon shrink-0", live)}>
        <LoadingIndicator size="inline" />
      </span> : <Icon
        data-slot="tool-fallback-trigger-icon"
        className={cn(
          "aui-tool-fallback-trigger-icon size-4 shrink-0",
          isCancelled && "text-muted-foreground",
          // @@@live-accent (Refs #6105) —— running 是 design.md 点名的 live 态之一。
        )}
      />}
      <span
        data-slot="tool-fallback-trigger-label"
        className={cn(
          "aui-tool-fallback-trigger-label-wrapper flex min-w-0 flex-1 items-baseline gap-2 text-start leading-none",
          isCancelled && "text-muted-foreground line-through",
          isRunning && "shimmer motion-reduce:animate-none",
        )}
      >
        {/*
          原本是 `Used tool: <名字>` —— 一句漏译的英文,还占掉手机上本来就不够的横向空间,
          于是一屏五张卡除了名字什么都看不出来(owner 2026-09-05:「这一堆神了」)。
          改成 orca 折叠行的形状:**名字 + 一句入参预览**,一眼看出这条 Read 读的是哪个文件。
        */}
        {isCancelled ? c.toolCancelledPrefix : null}
        <b className={cn("min-w-0 truncate", preview && "max-w-[45%] shrink-0")}>{toolName}</b>
        {preview ? (
          <span className="aui-tool-fallback-trigger-preview text-muted-foreground min-w-0 flex-1 truncate font-normal">
            {preview}
          </span>
        ) : null}
      </span>
      <ToolFallbackDuration />
      <ChevronDownIcon
        data-slot="tool-fallback-trigger-chevron"
        className={cn(
          "aui-tool-fallback-trigger-chevron size-4 shrink-0",
          "transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          "-rotate-90",
          "group-data-open/trigger:rotate-0",
          "group-data-panel-open/trigger:rotate-0",
        )}
      />
    </CollapsibleTrigger>
  );
}

function ToolFallbackContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={cn(
        "aui-tool-fallback-content relative overflow-hidden text-sm outline-none",
        "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
        "data-closed:animate-collapsible-up",
        "data-open:animate-collapsible-down",
        "data-closed:fill-mode-forwards",
        "data-closed:pointer-events-none",
        "[--tw-duration:var(--animation-duration)]",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "flex flex-col gap-2 ps-6 pt-1 pb-2 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
          "group-data-open/collapsible-content:animate-in group-data-open/collapsible-content:fade-in-0 group-data-open/collapsible-content:blur-in-[2px] group-data-open/collapsible-content:slide-in-from-top-1",
          "group-data-closed/collapsible-content:animate-out group-data-closed/collapsible-content:fade-out-0 group-data-closed/collapsible-content:blur-out-[2px] group-data-closed/collapsible-content:slide-out-to-top-1",
          "group-data-closed/collapsible-content:animation-duration-(--animation-duration) group-data-open/collapsible-content:animation-duration-(--animation-duration)",
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}

function ToolFallbackArgs({
  argsText,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  argsText?: string;
}) {
  if (!argsText) return null;

  return (
    <div
      data-slot="tool-fallback-args"
      className={cn("aui-tool-fallback-args", className)}
      {...props}
    >
      <pre className="aui-tool-fallback-args-value bg-muted/50 text-foreground/90 rounded-md p-2.5 text-xs whitespace-pre-wrap">
        {argsText}
      </pre>
    </div>
  );
}

function ToolFallbackResult({
  result,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  result?: unknown;
}) {
  if (result === undefined) return null;

  return (
    <div
      data-slot="tool-fallback-result"
      className={cn("aui-tool-fallback-result", className)}
      {...props}
    >
      <p className="aui-tool-fallback-result-header text-muted-foreground text-xs font-medium">
        Result:
      </p>
      <pre className="aui-tool-fallback-result-content bg-muted/50 text-foreground/90 mt-1 rounded-md p-2.5 text-xs whitespace-pre-wrap">
        {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
      </pre>
    </div>
  );
}

function ToolFallbackError({
  status,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  status?: ToolCallMessagePartStatus;
}) {
  // hook 必须在**任何提前 return 之前**取:这个组件有两处 early return,
  // 放在它们后面 = 有的渲染取、有的不取,hook 顺序就对不上了。
  const c = useAuiCopy();
  if (status?.type !== "incomplete") return null;

  const error = status.error;
  const errorText = error
    ? typeof error === "string"
      ? error
      : JSON.stringify(error)
    : null;

  if (!errorText) return null;

  const isCancelled = status.reason === "cancelled";
  const headerText = isCancelled ? c.toolCancelReason : c.toolErrorHeader;

  return (
    <div
      data-slot="tool-fallback-error"
      className={cn("aui-tool-fallback-error", className)}
      {...props}
    >
      <p className="aui-tool-fallback-error-header text-muted-foreground font-semibold">
        {headerText}
      </p>
      <p className="aui-tool-fallback-error-reason text-muted-foreground">
        {errorText}
      </p>
    </div>
  );
}

// 这四种 kind 的**集合**是协议里的常量,与语言无关;它们的**名字**才是文案(在 copy.ts)。
const KNOWN_APPROVAL_KINDS = [
  "allow-once",
  "allow-always",
  "reject-once",
  "reject-always",
] as const;

const isKnownKind = (kind: string) =>
  (KNOWN_APPROVAL_KINDS as readonly string[]).includes(kind);

const isAllowKind = (kind: string) =>
  kind === "allow-once" || kind === "allow-always";

/** provider 自己给了 label 就用它的;没给才落到咕咕这套兜底名字。 */
const approvalOptionLabel = (option: ToolApprovalOption, c: AuiCopy) =>
  option.label ??
  (isKnownKind(option.kind) ? approvalOptionLabels(c)[option.kind] : undefined) ??
  option.id;

/**
 * A request that declares how it wants to be presented is asking a question,
 * not gating an action, so a refusal is not one of the answers it accepts.
 */
const isQuestion = (approval: ToolCallMessagePart["approval"]) =>
  approval?.display === "select" || approval?.display === "text";

const offersInterruptAction = (
  status: ToolCallMessagePartStatus | undefined,
  approval: ToolCallMessagePart["approval"],
  interrupt: ToolCallMessagePart["interrupt"],
) =>
  status?.type !== "requires-action" ||
  status.reason !== "interrupt" ||
  approval != null ||
  interrupt != null;

function ToolFallbackApproval({
  className,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
  status,
  ...props
}: React.ComponentProps<"div"> &
  Partial<
    Pick<
      ToolCallMessagePartProps,
      "addResult" | "resume" | "respondToApproval" | "status"
    >
  > & {
    interrupt?: ToolCallMessagePart["interrupt"];
    approval?: ToolCallMessagePart["approval"];
  }) {
  const c = useAuiCopy();
  const [submitted, setSubmitted] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (
    approval != null &&
    (approval.approved !== undefined || approval.resolution !== undefined)
  )
    return null;

  if (!offersInterruptAction(status, approval, interrupt)) return null;

  // A declared option list is a host constraint: the kit never adds an
  // approval path beyond it, and preserves a refusal path only where the
  // request is an action the user may refuse.
  const declaredOptions = respondToApproval ? approval?.options : undefined;
  const acceptsText =
    approval != null &&
    respondToApproval != null &&
    toolApprovalAcceptsText(approval);

  // A refused response leaves the request open, so the controls come back
  // rather than staying spent on a decision the runtime never recorded.
  const submit = (send: () => Promise<void> | void) => {
    setSubmitted(true);
    setError(null);
    void (async () => {
      try {
        await send();
      } catch (sendError) {
        setSubmitted(false);
        setError(
          sendError instanceof Error ? sendError.message : String(sendError),
        );
      }
    })();
  };

  const respond = (approved: boolean) => {
    if (submitted) return;
    if (
      approval != null &&
      approval.approved === undefined &&
      respondToApproval
    ) {
      submit(() => respondToApproval({ approved, ...typedAnswer() }));
    } else if (interrupt) {
      submit(() => resume?.({ approved }));
    } else if (
      status?.type === "requires-action" &&
      status.reason === "interrupt"
    ) {
      return;
    } else {
      submit(() => addResult?.(approved ? c.approved : c.denied));
    }
  };

  const respondWithOption = (option: ToolApprovalOption) => {
    if (submitted) return;
    setConfirmingId(null);
    // A custom kind has no decision class for the runtime to derive, and
    // responding without one throws; picking a declared option is an answer,
    // so it resolves as approved.
    submit(() =>
      respondToApproval?.(
        isKnownKind(option.kind)
          ? { optionId: option.id, ...typedAnswer() }
          : { optionId: option.id, approved: true, ...typedAnswer() },
      ),
    );
  };

  const typedAnswer = () => (answer.trim() ? { text: answer } : {});

  const submitAnswer = () => {
    if (submitted || !answer.trim()) return;
    submit(() => respondToApproval?.({ text: answer }));
  };

  const handleOption = (option: ToolApprovalOption) => {
    if (option.confirm) {
      setConfirmingId(option.id);
    } else {
      respondWithOption(option);
    }
  };

  const confirming =
    confirmingId != null
      ? declaredOptions?.find((o) => o.id === confirmingId)
      : undefined;

  const question = isQuestion(approval);

  const promptText = approval?.prompt ? (
    <p className="aui-tool-fallback-approval-prompt text-foreground">
      {approval.prompt}
    </p>
  ) : null;

  const errorText = error ? (
    <p
      role="alert"
      className="aui-tool-fallback-approval-error text-destructive text-xs"
    >
      {error}
    </p>
  ) : null;

  const answerField = acceptsText ? (
    <div className="aui-tool-fallback-approval-answer flex flex-col items-start gap-2">
      <Textarea
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        disabled={submitted}
        aria-label={question ? (approval?.prompt ?? c.answerLabel) : c.noteLabel}
        placeholder={
          question ? c.answerPlaceholder : c.notePlaceholder
        }
      />
      {question && (
        <Button
          size="sm"
          className={pressable}
          onClick={submitAnswer}
          disabled={submitted || !answer.trim()}
        >
          Send
        </Button>
      )}
    </div>
  ) : null;

  if (confirming) {
    const confirmMeta =
      typeof confirming.confirm === "object" ? confirming.confirm : undefined;
    const confirmDescription =
      confirmMeta?.description ?? confirming.description;
    return (
      <div
        data-slot="tool-fallback-approval-confirm"
        className={cn(
          "aui-tool-fallback-approval-confirm flex flex-col gap-2 pt-1",
          className,
        )}
        {...props}
      >
        <p className="aui-tool-fallback-approval-confirm-title font-semibold">
          {confirmMeta?.title ?? `${approvalOptionLabel(confirming, c)}?`}
        </p>
        {confirmDescription && (
          <p className="aui-tool-fallback-approval-confirm-description text-muted-foreground">
            {confirmDescription}
          </p>
        )}
        {confirming.grants && confirming.grants.length > 0 && (
          <ul className="aui-tool-fallback-approval-confirm-grants flex flex-col gap-1">
            {confirming.grants.map((grant) => (
              <li key={grant}>
                <code className="aui-tool-fallback-approval-confirm-grant bg-muted rounded px-1.5 py-0.5 text-xs">
                  {grant}
                </code>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className={pressable}
            onClick={() => respondWithOption(confirming)}
            disabled={submitted}
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={pressable}
            onClick={() => setConfirmingId(null)}
            disabled={submitted}
          >
            Back
          </Button>
        </div>
      </div>
    );
  }

  if (declaredOptions && declaredOptions.length > 0) {
    const allowOptions = declaredOptions.filter((o) => isAllowKind(o.kind));
    const customOptions = declaredOptions.filter((o) => !isKnownKind(o.kind));
    const rejectOptions = declaredOptions.filter(
      (o) => isKnownKind(o.kind) && !isAllowKind(o.kind),
    );
    return (
      <div
        data-slot="tool-fallback-approval"
        className={cn(
          "aui-tool-fallback-approval flex flex-col gap-2 pt-1",
          className,
        )}
        {...props}
      >
        {promptText}
        <div className="flex flex-wrap items-center gap-2">
          {[...allowOptions, ...customOptions, ...rejectOptions].map(
            (option) => (
              <Button
                key={option.id}
                size="sm"
                variant={option === allowOptions[0] ? "default" : "outline"}
                className={pressable}
                onClick={() => handleOption(option)}
                disabled={submitted}
              >
                {approvalOptionLabel(option, c)}
              </Button>
            ),
          )}
          {rejectOptions.length === 0 && !question && (
            <Button
              size="sm"
              variant="outline"
              className={pressable}
              onClick={() => respond(false)}
              disabled={submitted}
            >
              Deny
            </Button>
          )}
        </div>
        {answerField}
        {errorText}
      </div>
    );
  }

  // A question carries no decision to fabricate, so it renders only what the
  // request declared, even when that leaves nothing to act on here.
  if (question) {
    return (
      <div
        data-slot="tool-fallback-approval"
        className={cn(
          "aui-tool-fallback-approval flex flex-col gap-2 pt-1",
          className,
        )}
        {...props}
      >
        {promptText}
        {answerField}
        {errorText}
      </div>
    );
  }

  return (
    <div
      data-slot="tool-fallback-approval"
      className={cn(
        "aui-tool-fallback-approval flex flex-col gap-2 pt-1",
        className,
      )}
      {...props}
    >
      {promptText}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className={pressable}
          onClick={() => respond(true)}
          disabled={submitted}
        >
          {c.allow}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className={pressable}
          onClick={() => respond(false)}
          disabled={submitted}
        >
          {c.deny}
        </Button>
      </div>
      {answerField}
      {errorText}
    </div>
  );
}

const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolName,
  args,
  argsText,
  result,
  status,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
}) => {
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";
  const isRequiresAction = status?.type === "requires-action";
  const shouldRenderApproval =
    isRequiresAction && offersInterruptAction(status, approval, interrupt);

  const [open, setOpen] = useState(isRequiresAction);
  const [prevRequiresAction, setPrevRequiresAction] =
    useState(isRequiresAction);
  if (isRequiresAction !== prevRequiresAction) {
    setPrevRequiresAction(isRequiresAction);
    if (isRequiresAction) setOpen(true);
  }

  // 咕咕把 provider 的 `inputSummary` 放在 args.summary。
  // 别的运行时没有这个约定,取不到就没有预览,行还是原样。
  const preview =
    args && typeof (args as { summary?: unknown }).summary === "string"
      ? (args as { summary: string }).summary
      : undefined;

  return (
    <ToolFallbackRoot open={open} onOpenChange={setOpen}>
      <ToolFallbackTrigger
        toolName={toolName}
        preview={preview}
        status={status}
      />
      <ToolFallbackContent>
        <ToolFallbackError status={status} />
        <ToolFallbackArgs
          argsText={argsText}
          className={cn(isCancelled && "opacity-60")}
        />
        {shouldRenderApproval && (
          <ToolFallbackApproval
            addResult={addResult}
            resume={resume}
            interrupt={interrupt}
            approval={approval}
            respondToApproval={respondToApproval}
            status={status}
          />
        )}
        {!isCancelled && <ToolFallbackResult result={result} />}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

const ToolFallback = memo(
  ToolFallbackImpl,
) as unknown as ToolCallMessagePartComponent & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Args: typeof ToolFallbackArgs;
  Result: typeof ToolFallbackResult;
  Error: typeof ToolFallbackError;
  Approval: typeof ToolFallbackApproval;
};

ToolFallback.displayName = "ToolFallback";
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.Error = ToolFallbackError;
ToolFallback.Approval = ToolFallbackApproval;

export {
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackError,
  ToolFallbackApproval,
};
