import { getPlugin } from '../../agents/plugin-registry';
import { resolveSessionpageSessionIntegration } from '@gugu/session-plugins/agents';
import type { Pty } from '../../pty/pty';
import { ptyOutputActivity } from '../../pty/pty-output-activity';
import { log } from '../../../lib/logger';
import type { Session } from '../../../../../../src/session/shared/core/sessions/sessions';
import {
  buildPromptInjectionPayload,
  buildSessionpageProjectContextBlock,
} from '../../../../../../src/session/shared/prompt-injection';
import { localAgentForSession } from '@main/core/sessionpage/sessionpage-session-agent';

// Keep the session-main boundary independent from the provisioning implementation. These cache keys are
// the persisted roster contract written by session-page provisioning.
const PROJECT_CACHE_KEY = 'emdash_project_id';
const GROUP_CACHE_KEY = 'sessionpage_group_chat_id';
function cacheString(cache: Record<string, unknown> | null | undefined, key: string): string {
  const value = cache?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function multilineEncodingFor(session: Session): 'bracketed-paste' | 'plain' {
  return resolveSessionpageSessionIntegration(session.providerId, 'tui').promptInput?.multiline
    ?? 'bracketed-paste';
}

// Inject only after the TUI has produced output and stayed idle for a beat;
// fixed delays race the agent's startup (auth, sync, model load).
const QUIET_PERIOD_MS = 800;
const MAX_WAIT_MS = 15_000;
const readyPtys = new WeakSet<Pty>();

/**
 * 这条 PTY 的**启动门**:门开之前,写进它的一切消息(首句、outbox 里排着的、用户刚发的)都先等着。
 *
 * 用于「进程起来了、但它要用的东西还没就绪」的家:Antigravity `agy` 在 gugu MCP 送出 `tools/list` 之前
 * 收到的那一轮,模型请求里没有咕咕的工具(2026-09-24 实测)。门由宿主给(sessionpage override 的
 * `startupGate`,来源 = GuguMcpHost 为这条会话的 grant 送出 `tools/list`),❌ 不是 sleep、❌ 不轮询。
 * 进程先退了 ⇒ 门以 `exited` 收场,在等的消息回 not-ready(与 `injectWhenReady` 同一个出口)。
 */
const startupGates = new WeakMap<Pty, Promise<'ready' | 'exited'>>();

export function setPtyStartupGate(pty: Pty, ready: Promise<void>): void {
  const exited = new Promise<'exited'>((resolve) => pty.onExit(() => resolve('exited')));
  const gate = Promise.race([ready.then(() => 'ready' as const), exited]);
  startupGates.set(pty, gate);
  void gate.then(() => {
    if (startupGates.get(pty) === gate) startupGates.delete(pty);
  });
}

/** 门开(或进程退出)之后再跑 `next`;没有门就直接跑。 */
function afterStartupGate<T>(pty: Pty, next: () => Promise<T>, onExited: () => T): Promise<T> {
  const gate = startupGates.get(pty);
  if (!gate) return next();
  return gate.then((outcome) => (outcome === 'exited' ? onExited() : next()));
}

function writeKeystrokes(pty: Pty, text: string): void {
  for (const character of text) pty.write(character);
}

/**
 * 「这条 PTY 已经过了启动期」是一个**粘性事实**:一旦成立就永远成立(启动只发生一次)。
 * 成立之后普通消息一律直接写 —— 回合正在刷屏时也不等静默,那是 spec keystroke-injection
 * 「普通消息不等待输出静默、不猜回合边界」那一句。
 *
 * ⚠️ 这个事实**怎么算出来的**是 #5558 的全部内容。从前它只有一条来路:「本进程已经成功注入过一次」。
 * 而 pi / copilot 这类 `prompt.kind: 'argv'` 的腿,首句是**命令行参数**递进去的、根本不经过注入器
 * ⇒ 这条来路永远不发生 ⇒ 用户从聊天页说的第一句话,就成了这条 PTY 上的第一条注入。
 * 那时 TUI 早已画完、正停在输入框等输入,于是下面那道门去等一个**不会再来的** `onData`,
 * 一直等到 `MAX_WAIT_MS` 才写出去。mac1 实测:pi 15 348ms、copilot 15 314ms(两家各自的第一条注入),
 * 而第二条起 215~367ms。
 *
 * ⇒ 现在它有了**第二条、也是真正的那条来路**:直接读 PTY 自己的输出活动事实
 * (`pty-output-activity.ts`,写入者是 registry 从 spawn 同一回合起就挂着的那个 `onData`)——
 * **出过字、且此刻已经静了 ≥ QUIET_PERIOD_MS,就是「启动期已过」本身**,不需要谁先注入一次来证明。
 * ❌ 不缩 `MAX_WAIT_MS`:那只是把一个错的 15 秒换成一个错的更小数字,还会截断真的需要等的那种情况。
 */
function hasSettledPastStartup(pty: Pty): boolean {
  if (readyPtys.has(pty)) return true;
  const activity = ptyOutputActivity(pty);
  // `null` = 这条 PTY 一个字节都没出过(写入者从 spawn 起就在看)⇒ 启动期还没结束,交给下面那道门。
  if (!activity) return false;
  if (Date.now() - activity.lastDataAt < QUIET_PERIOD_MS) return false;
  readyPtys.add(pty);
  return true;
}

export function planSystemBootstrap(
  text: string | undefined,
  transport: 'argv' | 'stdin-pipe' | 'keystroke' | 'none',
): { commandText?: string; readyText?: string } {
  if (!text?.trim()) return {};
  if (transport === 'none') {
    throw new Error('system bootstrap requires a declared prompt transport');
  }
  return transport === 'keystroke' ? { readyText: text } : { commandText: text };
}

/**
 * 声明了 `prompt.kind: 'none'` 的那条腿收不了注入的消息 —— 这句话要**指得出路**(#4653)。
 *
 * 三件写进同一句:①这条终端腿收不了注入的消息;②为什么(由 provider 自己声明的 `reason` 逐字
 * 带出来——`none` 有两种成因,无状态一次性引擎和"实测没有非-pty 通道"给出的下一步不一样);
 * ③改用哪条腿。❌ 不在这里按 provider 名字凑文案:那是把一条一般机制换成一张一家一行的表。
 */
export function isNoLocalMessageEncodingError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('declares no local message encoding');
}

function noLocalMessageEncodingError(
  providerId: string,
  promptDelivery: { kind: 'none'; reason?: string },
): Error {
  return new Error(
    `provider ${providerId} declares no local message encoding — this terminal (session-TUI) `
    + 'session cannot receive injected messages'
    + (promptDelivery.reason ? `: ${promptDelivery.reason}` : '.')
    + " Use this harness's ACP leg instead (turn Chat UI on when creating the agent).",
  );
}

function injectWhenReady(args: {
  pty: Pty;
  session: Session;
  text: string;
  messageId?: string;
}): Promise<'accepted' | 'not-ready'> {
  if (!args.text.trim()) return Promise.resolve('accepted');

  const plugin = getPlugin(args.session.providerId);
  const promptDelivery = plugin.capabilities.prompt;
  if (promptDelivery.kind === 'none') {
    return Promise.reject(
      noLocalMessageEncodingError(args.session.providerId, promptDelivery),
    );
  }

  const submitSequence = promptDelivery.kind === 'keystroke'
    ? (promptDelivery.submitSequence ?? '\r')
    : '\r';
  const submitDelayMs = promptDelivery.kind === 'keystroke'
    ? promptDelivery.submitDelayMs
    : undefined;

  const payload = buildPromptInjectionPayload({
    providerId: args.session.providerId,
    text: args.text,
    multilineEncoding: multilineEncodingFor(args.session),
  });

  return new Promise<'accepted' | 'not-ready'>((resolve, reject) => {
    let injected = false;
    let sawAnyOutput = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;

    const inject = () => {
      if (injected) return;
      injected = true;
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(maxWaitTimer);
      try {
        if (promptDelivery.kind === 'keystroke') {
          writeKeystrokes(args.pty, payload);
          const submit = () => {
            try {
              args.pty.write(submitSequence);
              resolve('accepted');
            } catch (error) {
              reject(error);
            }
          };
          if (submitDelayMs && submitDelayMs > 0) setTimeout(submit, submitDelayMs);
          else submit();
          return;
        }
        args.pty.write(`${payload}${submitSequence}`);
        resolve('accepted');
      } catch (error) {
        log.warn('SessionProvider: failed to inject ordinary message', {
          providerId: args.session.providerId,
          sessionId: args.session.id,
          messageId: args.messageId,
          error: String(error),
        });
        reject(error);
      }
    };

    const maxWaitTimer = setTimeout(inject, MAX_WAIT_MS);

    // 出过字、但此刻还没静够 ⇒ 静默窗**早就开始计时了**,这里只补**差的那一段**。
    // ⚠️ ❌ 不能把这条臂交给下一个 `onData` 去装:如果刚才那个就是最后一个字节,那个事件**不会再来**,
    //    于是这条消息又落回 `MAX_WAIT_MS`(#5558 那 15 秒的同一个形状,只是窗口窄了 800ms)。
    //    事实在 `pty-output-activity.ts` 里,写入者从 spawn 同一回合起就在记 —— 读它,别重新观察。
    const activity = ptyOutputActivity(args.pty);
    if (activity) {
      sawAnyOutput = true;
      quietTimer = setTimeout(inject, Math.max(QUIET_PERIOD_MS - (Date.now() - activity.lastDataAt), 0));
    }

    args.pty.onData(() => {
      if (injected) return;
      sawAnyOutput = true;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(inject, QUIET_PERIOD_MS);
    });

    args.pty.onExit(() => {
      readyPtys.delete(args.pty);
      const messageWasInjected = injected;
      injected = true;
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(maxWaitTimer);
      if (!messageWasInjected) {
        log.warn('SessionProvider: PTY exited before ordinary message could be injected', {
          providerId: args.session.providerId,
          sessionId: args.session.id,
          messageId: args.messageId,
          sawAnyOutput,
        });
        resolve('not-ready');
      }
    });
  });
}

function injectImmediately(args: {
  pty: Pty;
  session: Session;
  text: string;
  messageId: string;
}): Promise<'accepted'> {
  const plugin = getPlugin(args.session.providerId);
  const promptDelivery = plugin.capabilities.prompt;
  if (promptDelivery.kind === 'none') {
    return Promise.reject(
      noLocalMessageEncodingError(args.session.providerId, promptDelivery),
    );
  }

  const submitSequence = promptDelivery.kind === 'keystroke'
    ? (promptDelivery.submitSequence ?? '\r')
    : '\r';
  const submitDelayMs = promptDelivery.kind === 'keystroke'
    ? promptDelivery.submitDelayMs
    : undefined;
  const payload = buildPromptInjectionPayload({
    providerId: args.session.providerId,
    text: args.text,
    multilineEncoding: multilineEncodingFor(args.session),
  });

  try {
    if (promptDelivery.kind === 'keystroke') {
      writeKeystrokes(args.pty, payload);
      return new Promise<'accepted'>((resolve, reject) => {
        const submit = () => {
          try {
            args.pty.write(submitSequence);
            resolve('accepted');
          } catch (error) {
            reject(error);
          }
        };
        if (submitDelayMs && submitDelayMs > 0) setTimeout(submit, submitDelayMs);
        else submit();
      });
    }
    args.pty.write(`${payload}${submitSequence}`);
    return Promise.resolve('accepted');
  } catch (error) {
    log.warn('SessionProvider: failed to inject ordinary message', {
      providerId: args.session.providerId,
      sessionId: args.session.id,
      messageId: args.messageId,
      error: String(error),
    });
    return Promise.reject(error);
  }
}

export function injectSessionMessageWhenReady(args: {
  pty: Pty;
  session: Session;
  message: { id: string; text: string };
}): Promise<{ status: 'not-ready' } | { status: 'accepted'; messageId: string }> {
  return afterStartupGate(
    args.pty,
    () => injectSessionMessagePastGate(args),
    () => ({ status: 'not-ready' as const }),
  );
}

function injectSessionMessagePastGate(args: {
  pty: Pty;
  session: Session;
  message: { id: string; text: string };
}): Promise<{ status: 'not-ready' } | { status: 'accepted'; messageId: string }> {
  if (hasSettledPastStartup(args.pty)) {
    return injectImmediately({
      pty: args.pty,
      session: args.session,
      text: args.message.text,
      messageId: args.message.id,
    }).then(() => ({ status: 'accepted', messageId: args.message.id }));
  }
  return injectWhenReady({
    pty: args.pty,
    session: args.session,
    text: args.message.text,
    messageId: args.message.id,
  }).then((status) => {
    if (status !== 'accepted') return { status };
    readyPtys.add(args.pty);
    return { status, messageId: args.message.id };
  });
}

export function injectSystemBootstrapWhenReady(args: {
  pty: Pty;
  session: Session;
  text: string;
  projectPath?: string;
}): Promise<void> {
  return afterStartupGate(args.pty, () => injectSystemBootstrapPastGate(args), () => undefined);
}

function injectSystemBootstrapPastGate(args: {
  pty: Pty;
  session: Session;
  text: string;
  projectPath?: string;
}): Promise<void> {
  if (!args.projectPath) {
    return injectWhenReady(args).then((status) => {
      if (status === 'accepted') readyPtys.add(args.pty)
    })
  }
  const context = localAgentForSession(args.session.id, process.env)
    .then((agent) => {
      const projectName = args.projectPath?.split('/').filter(Boolean).at(-1) || args.session.projectId
      return buildSessionpageProjectContextBlock({
        projectId: cacheString(agent?.cache, PROJECT_CACHE_KEY) || args.session.projectId,
        projectName,
        projectPath: args.projectPath,
        groupChatId: cacheString(agent?.cache, GROUP_CACHE_KEY),
        groupName: projectName,
      })
    })
    .catch(() => '')
  return context.then((projectBlock) => injectWhenReady({
    ...args,
    text: projectBlock ? `${args.text}\n${projectBlock}` : args.text,
  })).then((status) => {
    if (status === 'accepted') readyPtys.add(args.pty);
  });
}
