import { resolveSessionPermissionMode } from '../../../acp/models/permissions';
import type { AgentCommand, CommandContext } from '../capabilities/prompt';

/** Quote a single shell argument safely for POSIX shells. */
export function quoteShellArg(arg: string): string {
  if (arg === '') return "''";
  if (!/[^a-zA-Z0-9.,_:/@=+-]/u.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

/** Wrap a command with stdin pipe delivery for an initial prompt. */
export function wrapWithStdinPipe(cmd: AgentCommand, prompt: string): AgentCommand {
  const agentLine = [cmd.command, ...cmd.args].map(quoteShellArg).join(' ');
  const shellLine = `printf '%s\n' ${quoteShellArg(prompt)} | ${agentLine}`;
  // ...cmd 先展开:包一层 shell 不改变「这条 argv 上有没有 auto-approve flag」这件事实,
  // 而漏掉它会让下游把一个自动批准的会话读成阻塞在人。
  return { ...cmd, command: 'bash', args: ['-c', shellLine] };
}

/**
 * Spec for standard command building; mirrors `AgentProviderDefinition` fields
 * but typed for use in buildStandardCommand.
 */
export type StandardCommandSpec = {
  /** Args always appended after the binary. */
  defaultArgs?: string[];
  /** Flag for auto-approve mode, e.g. '--dangerously-skip-permissions'. */
  autoApproveFlag?: string;
  /**
   * 只读档的 flag(codex `-s read-only`)。
   *
   * ⚠️ **声明了才代表这个 harness 真能只读**,composer 也只在声明了它的 agent 上显示只读档。
   * 有的 harness 默认行为本身就是只读(claude 不加 flag = `default` = 只读),那就不填 ——
   * 它的只读能力由 capability 的 modes 声明,不由这里的 flag 决定。
   * ❌ 不要为了「三档看起来齐」而随便填一个:摆一个实际不生效的档位,和这次 codex 那个
   * 空权限档是同一种错法 —— 用户以为自己锁住了 agent,其实没有。
   */
  readOnlyFlag?: string;
  /**
   * 规划档的 flag(claude `--permission-mode plan`、gemini `--approval-mode plan`)。
   *
   * ⚠️ 与只读档同理:**声明了才代表这个 harness 真有规划档**。没有 plan 的 harness
   * (codex 只有 :read-only/:workspace/:danger-full-access)不填,composer 就不摆这一档。
   * ❌ 不要拿 readOnlyFlag 顶替:规划不是「更严的只读」,是另一件事 —— 只读允许 agent
   * 动手做只读的事,规划连动手的意图都不产生,只产出方案。顶替会让用户以为选了规划,
   * 实际拿到只读的行为。
   */
  planFlag?: string;
  /**
   * 编辑档的 flag(claude `--permission-mode acceptEdits`)。
   *
   * ⚠️ 只有**默认行为不是编辑档**的 harness 才需要它:codex 不加 flag 就是 workspace-write,
   * 填了反而多余;claude 不加 flag 是 `default`(只读),不填的话「编辑」会静默变成「只读」——
   * agent 什么都改不了,而用户以为自己给了写权限。默认行为是哪一档,得去它自己的文档核实。
   */
  editFlag?: string;
  /**
   * Flag for initial prompt, e.g. '-i' or '--prompt'. Empty string = positional
   * (prompt appended as last arg without a flag). Leave undefined to skip prompt injection.
   */
  initialPromptFlag?: string;
  /** Whether the initial prompt should be delivered via stdin pipe instead of CLI args. */
  initialPromptViaStdinPipe?: boolean;
  /**
   * Flag for session resume, e.g. '--resume'. When isResuming and sessionId is set,
   * the session ID is appended after this flag. When sessionIdOnResumeOnly is true and
   * we are resuming without a sessionId, `resumeWithoutSessionFlag` is used.
   */
  resumeFlag?: string;
  /**
   * Flag for passing a session ID, e.g. '--session-id'. On fresh sessions (non-resuming),
   * the session-page session UUID is passed. On resume sessions, `resumeFlag` is used instead.
   * If both are the same flag (e.g. grok/copilot), set sessionIdOnResumeOnly=true.
   */
  cliSessionIdFlag?: string;
  /** Only pass sessionId when resuming, not on fresh sessions. */
  cliSessionIdOnResumeOnly?: boolean;
  /** Resume flag used when sessionIdOnResumeOnly=true but sessionId is absent (no stored session yet). */
  resumeWithoutSessionFlag?: string;
  /**
   * A flag appended when starting a fresh conversation (e.g. a vendor's `--new`).
   * ⚠️ 2026-09-21(#6097):它唯一的生产者 letta 随插件删掉了 —— 今天这一格**零声明**。
   *    字段与下面那条分支留着是**给下一家用的通用位**,不是还在服务谁;❌ 别据此以为它有读数。
   */
  newSessionFlag?: string;
  /**
   * Flag that turns a resume into a fork, e.g. claude's '--fork-session'. Used only when
   * ctx.forkFromSessionId is set: emits `<resumeFlag> <forkFromSessionId> <forkFlag>` and,
   * when sessionIdFlag applies, the new session id so the fork spawns under ctx.sessionId.
   */
  forkFlag?: string;
  /**
   * Subcommand that forks a session by taking the source session id as a positional arg,
   * e.g. codex's 'fork' (`codex fork <src>`). Unlike forkFlag (which is additive to resume),
   * this REPLACES the resume subcommand and the provider mints the new session id itself —
   * so no sessionIdFlag is emitted. Set either this or forkFlag for a fork-capable provider.
   */
  forkCommand?: string;
  /**
   * The provider's host adapter performs the fork after command construction. This keeps the
   * source id out of the visible CLI argv; callers must reject the spawn if no host override lands.
   */
  forkHandledByHost?: boolean;
  /**
   * When true, sessionIdFlag is injected on both fresh AND resume sessions.
   * Use for providers like Antigravity that identify conversations by ID on every invocation.
   */
  cliSessionIdAlways?: boolean;
  /** Add the logical session id to an additive fork. Providers that mint the child id in init
   * (Claude) must leave this false so the source/child binding stays provider-owned. */
  cliSessionIdOnFork?: boolean;
  /** List of singleton flags to deduplicate (keep first occurrence only). */
  deduplicateFlags?: string[];
  /** Validate a session ID before using it for resume (e.g. opencode needs 'ses' prefix). */
  validateProviderSessionId?: (id: string) => boolean;
  /** Extra static env vars to inject (on top of ctx env). */
  extraEnv?: Record<string, string>;
  /**
   * CLI flag for model selection, e.g. '--model' or '-m'.
   * When ctx.model is non-empty, appendFlagValue(args, modelFlag, ctx.model) is called.
   * Supports both '--flag value' and '--flag=value' forms via appendFlagValue.
   */
  modelFlag?: string;
  /**
   * CLI flag carrying the reasoning-effort level, e.g. '--effort' or
   * '-c model_reasoning_effort='. Applied like modelFlag when ctx.effort is non-empty.
   * Leave undefined for agents whose CLI takes no effort argument — the composer then has
   * no way to honour a pre-session pick on the PTY path, so the level must not be offered.
   */
  effortFlag?: string;
};

/**
 * Build a standard AgentCommand from a CommandContext, applying the spec's flag patterns.
 * Handles: defaultArgs, resume/session flags, auto-approve, and prompt delivery.
 */
export function buildStandardCommand(ctx: CommandContext, spec: StandardCommandSpec): AgentCommand {
  if (ctx.forkFromProviderSessionId && ctx.isResuming) {
    throw new Error('forkFromSessionId and isResuming are mutually exclusive');
  }
  if (
    ctx.forkFromProviderSessionId &&
    !spec.forkHandledByHost &&
    !spec.forkCommand &&
    (!spec.resumeFlag || !spec.forkFlag)
  ) {
    throw new Error('fork requested but no verified fork adapter is configured');
  }

  const args: string[] = [];
  const env: Record<string, string> = { ...spec.extraEnv };

  // Default args (e.g. kiro's ['chat', '--agent', 'gugu'])
  if (spec.defaultArgs?.length) {
    args.push(...spec.defaultArgs);
  }

  // Session / resume logic.
  // For sessionIdOnResumeOnly providers, use only the provider-native session id.
  // If providerSessionId is absent, validSessionId will be undefined → fallback flags apply.
  // For all other providers, the session-page session UUID (sessionId) is used.
  const rawCliSessionId = spec.cliSessionIdOnResumeOnly ? ctx.providerSessionId : ctx.cliSessionId;
  const hasCliSessionId = !!rawCliSessionId;
  const validCliSessionId =
    hasCliSessionId && spec.validateProviderSessionId
      ? spec.validateProviderSessionId(rawCliSessionId!)
        ? rawCliSessionId!
        : undefined
      : rawCliSessionId;

  if (ctx.isResuming) {
    if (spec.cliSessionIdAlways && spec.cliSessionIdFlag && ctx.cliSessionId) {
      // Always inject session ID on resume too (e.g. Antigravity --conversation=)
      appendFlagValue(args, spec.cliSessionIdFlag, ctx.cliSessionId);
    } else if (spec.resumeFlag) {
      if (spec.cliSessionIdFlag && validCliSessionId) {
        // resumeFlag takes the session ID (e.g. '--resume <id>' or '-r <id>')
        args.push(...splitFlag(spec.resumeFlag), validCliSessionId);
      } else if (spec.cliSessionIdFlag && !spec.cliSessionIdOnResumeOnly) {
        // Use the session-page UUID
        args.push(...splitFlag(spec.resumeFlag), ctx.cliSessionId!);
      } else if (spec.resumeWithoutSessionFlag) {
        args.push(...splitFlag(spec.resumeWithoutSessionFlag));
      } else {
        args.push(...splitFlag(spec.resumeFlag));
      }
    }
  } else if (ctx.forkFromProviderSessionId && !spec.forkHandledByHost) {
    if (spec.forkCommand) {
      // Subcommand fork (codex `fork <src>`): replaces resume, source id is positional, and
      // the provider mints the new session id (the host learns it later via the session hook) —
      // so no sessionIdFlag is emitted here.
      args.push(...splitFlag(spec.forkCommand), ctx.forkFromProviderSessionId);
    } else {
      // Additive fork (claude `--resume <src> --fork-session`): the new session spawns under
      // ctx.sessionId when the provider takes an explicit session-id flag.
      args.push(...splitFlag(spec.resumeFlag!), ctx.forkFromProviderSessionId);
      args.push(...splitFlag(spec.forkFlag!));
      if (spec.cliSessionIdOnFork !== false && spec.cliSessionIdFlag && !spec.cliSessionIdOnResumeOnly && ctx.cliSessionId) {
        appendFlagValue(args, spec.cliSessionIdFlag, ctx.cliSessionId);
      }
    }
  } else {
    // Fresh session
    if (spec.cliSessionIdFlag && !spec.cliSessionIdOnResumeOnly && ctx.cliSessionId) {
      appendFlagValue(args, spec.cliSessionIdFlag, ctx.cliSessionId);
    } else if (spec.newSessionFlag) {
      args.push(spec.newSessionFlag);
    }
  }

  // 权限档。档位缺席时按旧布尔补(与界面、聊天面板腿同一个答案,`resolveSessionPermissionMode`),
  // 补出来的档照样显式推旗标。❌ 「没带档位就一个旗标都不加」:不加旗标不是任何一档,是 harness 自己挑
  // (claude 读用户的 defaultMode,再没有就是账号默认档 —— Max 账号实测 `auto`,#7366)。
  // ⚠️ `autoApproved` 记的是「这条 argv 上真的有那个 flag」,不是「用户选了完全访问」:这家没声明 flag 时,
  // 用户的档位一个字节都没到达进程。resume 与新起一样推档位旗标。
  const mode = resolveSessionPermissionMode(ctx);
  // ❌ 只读档没声明 flag 时**什么都不加**,绝不退回 autoApproveFlag:那是把「锁住 agent」
  //    翻译成「放开 agent」,方向正好反了。composer 也不会在这种 agent 上给出只读档。
  const autoApproved = mode === 'full-access' && spec.autoApproveFlag !== undefined;
  const permissionFlag = mode === 'full-access'
    ? spec.autoApproveFlag
    : mode === 'plan'
      ? spec.planFlag
      : mode === 'read-only'
        ? spec.readOnlyFlag
        : spec.editFlag;
  if (permissionFlag) args.push(...splitFlag(permissionFlag));

  // Model selection
  if (spec.modelFlag && ctx.model) {
    appendFlagValue(args, spec.modelFlag, ctx.model);
  }

  // Reasoning effort
  if (spec.effortFlag && ctx.effort) {
    appendFlagValue(args, spec.effortFlag, ctx.effort);
  }

  // User extra args
  if (ctx.extraArgs?.length) {
    args.push(...ctx.extraArgs);
  }

  // Initial prompt — only on fresh sessions
  if (!ctx.isResuming && ctx.initialPrompt) {
    if (spec.initialPromptViaStdinPipe) {
      // Handled later by caller via wrapWithStdinPipe
    } else if (spec.initialPromptFlag !== undefined) {
      if (spec.initialPromptFlag === '') {
        args.push(ctx.initialPrompt);
      } else {
        args.push(...splitFlag(spec.initialPromptFlag), ctx.initialPrompt);
      }
    }
  }

  const finalArgs = spec.deduplicateFlags?.length ? dedupeFlags(args, spec.deduplicateFlags) : args;

  // 只在**真的推了** flag 时写这一格:没推 = 字段缺席 = 保守的那一侧。
  // 这样「这条 argv 长什么样」的既有逐字节判据在没推 flag 的那些 harness 上一个字节不变。
  const command: AgentCommand = {
    command: ctx.cli,
    args: finalArgs,
    env,
    ...(autoApproved && { autoApproved: true }),
    ...(spec.forkHandledByHost && ctx.forkFromProviderSessionId ? { forkHandledByHost: true } : {}),
  };

  // Wrap with stdin pipe if needed
  if (!ctx.isResuming && ctx.initialPrompt && spec.initialPromptViaStdinPipe) {
    return wrapWithStdinPipe(command, ctx.initialPrompt);
  }

  return command;
}

function splitFlag(flag: string): string[] {
  return flag.split(/\s+/).filter(Boolean);
}

function appendFlagValue(args: string[], flag: string, value: string): void {
  // A flag ending in '=' glues the value onto its *last* token, so a multi-token spec like
  // codex's '-c model_reasoning_effort=' yields ['-c', 'model_reasoning_effort=high'] —
  // two argv entries, matching how the notify override is already passed.
  const parts = splitFlag(flag);
  const last = parts.at(-1);
  if (last?.endsWith('=')) {
    args.push(...parts.slice(0, -1), `${last}${value}`);
  } else {
    args.push(...parts, value);
  }
}

function dedupeFlags(args: string[], flags: string[]): string[] {
  const singletons = new Set(flags);
  const seen = new Set<string>();
  return args.filter((arg) => {
    if (!singletons.has(arg)) return true;
    if (seen.has(arg)) return false;
    seen.add(arg);
    return true;
  });
}
