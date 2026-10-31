import { isSignInFailure, type AdapterExit, type SessionFailure, type TranscriptTurnOutcome } from '@gugu/session-core/acp';
import { guguReasonInText } from '@gugu/session-core/session-record/contract';
import { errorDetail, type SerializedError } from '@gugu/session-shared';
import { redactAll, redactSecrets } from '@gugu/session-shared/logger';

/**
 * 一次回合失败的**事实**,按它**在哪个边界被观测到**分类。
 *
 * 分类只在本文件发生。调用点只负责把它手上那个边界的事实原样交出来 ——
 * ❌ 不在调用点挑 reason、❌ 不在渲染层按字符串认人、❌ 不给某一家 harness 开分支。
 *
 * # 为什么按「边界」而不是按「错误长什么样」
 *
 * 因为边界是我们**确实知道**的那一格,而错误的样子不是。2026-09-20 真机读数:
 * 同一条 `agent.prompt()` 的 catch 上,一次拿到 `Error/"ACP connection closed"`(引擎被杀),
 * 一次拿到 `RequestError/"Input exceeds the maximum length of 1048576 characters."`
 * (适配器拒收)。两者除了都是"prompt 被拒"之外没有共同形状 —— 谁想从字符串里认出
 * 「这是进程死了」,就得开始猜。而在**进程退出**那个回调上,"进程死了"是已知的,不用猜。
 */
export type TurnFailureFact =
  /** `session/prompt` 这一整轮被拒(上游网关回错、适配器拒收、连接在飞行中断)。 */
  | {
      at: 'prompt';
      cause: SerializedError;
      /** 跑的是咕咕平台模型:被鉴权拒说的是平台那一侧,❌ 标成这家的登录失效(#6264)。 */
      platformCredentials?: boolean;
      /**
       * 宿主先要求关掉了这条会话。有的家在 `session/close` 里自己把在飞的 prompt 答成 `cancelled`(claude),
       * 有的家不答,连接随宿主拆掉,prompt 以「线断了」被拒(codex)。两者是同一件事:人把它停了。
       */
      closeRequested?: boolean;
      /** 这一轮来要票、咕咕没签出来的原因码(宿主递进来的,见 SessionCell.noteCredentialRefusal)。 */
      credentialRefusal?: string | null;
    }
  /**
   * 适配器进程在回合还开着的时候退出了。
   *
   * `priorDetail` = 这一轮**已经**落定过的那句话(连接塌掉时 `session/prompt` 抛出来的那句)。
   * 它与退出这件事说的是同一件事,而退出更具体 ⇒ 退出的事实在前、它在后,两句都留着:
   * 那句话偶尔真的是 provider 说的(先网关报错、适配器随后才崩),丢掉就又丢了一次真因。
   */
  | { at: 'process-exit'; exit: AdapterExit; priorDetail?: string }
  /**
   * 连接丢过一次、现在重连回来了 —— 断开时在飞的那一轮**结局不明**,
   * 由重连这一侧替它收口。原因与上一支同源(适配器没了),所以落同一个 reason。
   */
  | { at: 'connection-lost'; failure: SessionFailure | null };

/**
 * 一次分类的结果:这一轮的终局,加上**它还能不能被改口**。
 *
 * `provisional` 不是时间窗,是一种**显式状态**:它说的是「我在这个边界上只看到线断了,
 * 更外层的退出事实可以 refine 它」。只有它为真的那一条,才允许被
 * `turn_outcome_superseded` 改写。
 *
 * ⚠️ 这一格是被一个**会把修复自己吃掉**的漏洞逼出来的(2026-09-20 评审抓到):
 * 早一版的守卫是「没有活跃轮 + 上一轮是 error」。照它走一遍——
 * 某一轮因**网关 4xx** 失败(detail 里带着上游 message 与 request id,**这正是 #5858 要的**),
 * 用户随手关掉会话、引擎退出 ⇒ 守卫成立 ⇒ 那句唯一能归因的话被**自己的修复**改写成「进程没了」。
 * 而「失败一轮 → 关掉会话」是最常见的收尾路径之一,同时它还把 #4875 ② 整个退回去。
 * ⇒ **能不能改口由分类器一处决定**,与「谁产出 reason/detail 只有一处」是同一条纪律;
 *   ❌ 不在结算点上按时序推断。
 */
export type ClassifiedTurnFailure = {
  outcome: TranscriptTurnOutcome;
  provisional: boolean;
};

/**
 * 这次拒绝里**有没有 provider 自己写的内容**。
 *
 * # 为什么判的是这个,而不是那句话长什么样
 *
 * 第一版写的是 `/connection closed/i`。评审当场点掉:那是**按字符串认人**,而本仓明令禁止。
 * 顺着它查了一遍产出者,两条读数:
 *
 * 1. `ACP connection closed` **不是我们写的** —— 它出自厂商 SDK
 *    `@agentclientprotocol/sdk@1.4.0` 的 `dist/acp.js:209`
 *    (`updates.fail(closeSignal.reason ?? new Error("ACP connection closed"))`),
 *    连接关掉、又没给 reason 时用来拒掉所有在飞请求。
 * 2. 而那条正则**还多罩住了一个产出者**:我们自己的桥
 *    `apps/desktop/electron/runtime/codex-app-server-acp.mjs:2505`,在 `shutdown()` 里
 *    `cancelAcpPending('ACP host connection closed')`(中间多一个 **host**)。
 *
 * 两个产出者做的是同一件事:**线断了,谁都没机会说话**。而它们的措辞随时会漂
 * (一个在厂商手里,一个在我们另一条腿里)。⇒ 与其去背两句话,不如问一个不会漂的问题:
 * **provider 到底有没有说话?**
 *
 * 说了 ⇒ 那句话是它的,`final`,**永不可被改口**(网关 4xx 的 message + request id、
 * 适配器拒收的 `input_too_large`,都从这里走)。
 * 没说 ⇒ 我们只看到线断了,`provisional`,更外层的退出事实可以 refine 它。
 *
 * ⚠️ 失效方向是安全的那一侧:拿不准就算**说过话** ⇒ 不改口。哪天 SDK 换了措辞,这里一个字
 * 都不用动;哪天某个 provider 开始用裸 `Error` 回错误,最坏结果也只是 reason 从
 * `prompt_failed` 变成 `process_closed`,而**它那句话仍然原样留在 detail 的第二行**。
 *
 * ⚠️ **`code` 只认数字**(评审抓到,2026-09-20)。**这两半是同一次改动的两端,它们互相咬到了**:
 * 一端是「让 `toSerializedError` 保住 `code`」(为了把上游的协议码送上屏),
 * 另一端是「用 `code` 判 provider 说没说话」。分开看都对,合起来就把一类传输层错误判反了 ——
 * 改动的两端要一起读,这就是出处。本次一并让 `toSerializedError` 保住 `code`,
 * 而 **Node 的传输层错误也带 `code`** —— `EPIPE` / `ECONNRESET` / `ERR_STREAM_DESTROYED`,
 * 全是**字符串** errno。那恰恰是「线断了、provider 一个字没说」本身:管子在写的时候被拔了。
 * 认了它就会把这一类锁成 `prompt_failed`,把整条改口路径关掉 —— 也就是把本票修的东西修回去。
 * ⇒ JSON-RPC 的 `code` 是**数字**,errno 是**字符串**,这一格就是它们的分界。
 */
function providerAuthored(cause: SerializedError): boolean {
  // 能用的那句话按协议惯例挂在 data(或 data.details);`RequestError` 是 SDK 给
  // 「provider 回了一个错误响应」的类名,单独认一道,免得既没 code 也没 data 的协议错误漏掉。
  if (cause.data !== undefined || cause.name === 'RequestError') return true;
  return typeof cause.code === 'number';
}

/** 适配器退出这件事本身能说的话:退出码/信号 + 它最后说了什么。 */
function adapterExitDetail(exit: AdapterExit): string | undefined {
  const facts: string[] = [];
  if (exit.exitCode !== null) facts.push(`exit code=${exit.exitCode}`);
  if (exit.signal) facts.push(`signal=${exit.signal}`);
  const head = facts.length > 0 ? facts.join(', ') : undefined;
  const tail = exit.stderrTail.trim() || undefined;
  if (head && tail) return `${head}\n${tail}`;
  return head ?? tail;
}

const MAX_SAID_LENGTH = 280;

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 上游(网关 / provider)回给 harness 的那一句,一行 —— 「回合失败」那一行直接说它(#7103)。只认 codex 递上来的两种形状
 * (codex 0.156.1 `codex-rs/protocol/src/error.rs`):
 * - 400:HTTP 错误体本身(`{"error":{"message":…,"code":…}}`),codex 原样当 turn.error.message,桥原样转成这一轮的错;
 * - 其余状态:`unexpected status <码> <原因>: <体>`,后面可能依次跟 `, url: …`、`, cf-ray: …`、`, request id: …`、
 *   `, auth error: …`。体是带 `error.message` 的 JSON 时 codex 已经替我们取成纯文本;从第一个 `, url: ` 起整段去掉
 *   (本机中转地址和 codex 自己附上的那几段)。
 * 取 `error.message`(或体本身的 `message`,或状态行后面那段纯文本)的第一行,去敏(令牌、路径、IP)、按码点限长;
 * 上游自己写进那句话里的 `(request id: …)` 原样留着。以 `<` 开头的(网关前面 nginx 回的 HTML 错误页)不说。
 * 认不出 ⇒ undefined,那一行照旧说「回合未能完成」,原文在详情里 —— claude 的「API Error: 400 …」已经作为它自己的话
 * 进了转录,不是这两种形状,❌ 在这一行再说一遍。
 */
export function upstreamSaid(text: string, data?: unknown): string | undefined {
  // Structured JSON-RPC data.message is the provider's own cause, including plain 5xx text.
  const message = data && typeof data === 'object' ? (data as Record<string, unknown>).message : undefined;
  const structured = typeof message === 'string' ? message : undefined;
  const trimmed = (structured ?? text).trim();
  const status = /^unexpected status \d{3}[^:]*:\s*([\s\S]*?)(?:,\s*url:\s[\s\S]*)?$/.exec(trimmed);
  const body = status ? status[1]!.trim() : trimmed;
  const json = body.startsWith('{') ? parseJsonObject(body) : undefined;
  const nested = json?.error && typeof json.error === 'object' ? (json.error as Record<string, unknown>).message : undefined;
  const said = typeof nested === 'string' ? nested
    : typeof json?.message === 'string' ? json.message
    : (status || structured !== undefined) && !json ? body
    : undefined;
  const line = said?.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  if (!line || line.startsWith('<')) return undefined;
  return Array.from(redactAll(line)).slice(0, MAX_SAID_LENGTH).join('');
}

/** 咕咕拒了这一轮的票(原因码)⇒ 这一轮的终局;不是原因码 ⇒ null。`settledOutcome` 与 prompt 被拒两条路共用。 */
export function refusedTurnOutcome(code: string | null | undefined): TranscriptTurnOutcome | null {
  const guguReason = guguReasonInText(code);
  return guguReason ? { kind: 'error', reason: 'prompt_failed', guguReason } : null;
}

/**
 * 把一条失败事实结算成这一轮的终局。**全仓只有这一个地方决定 `reason` 与 `detail`。**
 *
 * `reason` 要能把「下一步该做什么」分开:
 * - `prompt_failed` ⇒ 去看上游/指令本身(网关、配额、凭据、这条指令太大);
 * - `process_closed` ⇒ 引擎没了,重开会话。
 * 这两件事此前共用 `prompt_failed` 一个哨兵值(#4875 ②),而它们的下一步动作完全不同;
 * 更糟的是 `prompt_failed` 的文案是「这条指令没能送达」—— 引擎死掉那一格里
 * **指令其实送达了**,那句话与事实相反。
 *
 * `detail` 一律是**出事那一侧自己说的话**,逐字。超长由界面折叠,❌ 不在这里截断。
 * 返回值第二格 `provisional` 见上面 `ClassifiedTurnFailure` —— 它决定这一条能不能被改口。
 */
export function classifyTurnFailure(fact: TurnFailureFact): ClassifiedTurnFailure {
  switch (fact.at) {
    case 'prompt': {
      // A JSON-RPC cancellation remains a cancelled turn even when admission failed.
      // 线是我们自己断的、provider 没说话 ⇒ 这一轮被停下,与它在 close 时答 `cancelled` 同一个结局。
      // provider 说过话的那一条仍是它的话(final),❌ 被「我们在关」盖掉。
      if (fact.cause.code === -32800 || (fact.closeRequested && !providerAuthored(fact.cause))) {
        return { outcome: { kind: 'cancelled', reason: 'cancelled' }, provisional: false };
      }
      // #7103 这一轮是咕咕拒的(取票没签出来):咕咕按原因说,这一家那句(claude 的「apiKeyHelper is failing」、
      // 转发回来的 403)不是拒绝方的话,❌ 进 detail。拒绝是终局,❌ 被后来的进程退出改口。
      const refused = fact.platformCredentials ? refusedTurnOutcome(fact.credentialRefusal) : null;
      if (refused) return { outcome: refused, provisional: false };
      // ⚠️ 过一道去敏,**与适配器 stderr 尾巴走的是同一道闸**(`boundedRedactedLine`)。
      // 这一段会上屏、也会随转录落盘,而 provider 完全可能把 auth 头或 key 回显在
      // `message` / `data` 里(评审抓到:那一侧有闸,这一侧当时没有)。
      const detail = redactSecrets(errorDetail(fact.cause) || fact.cause.name.trim());
      // 这家在这台机器上的登录不能用了(#6264):同一个 reason,多一格让界面说「登录已失效 · 重新登录」,
      // 并让宿主把这家标成「登录已失效」。判据只认结构化信号,见 `isSignInFailure`。
      const signInRequired = !fact.platformCredentials && isSignInFailure(fact.cause);
      // #7103 上游自己说了什么(codex 原样递上来的网关错误体):那一行直接说它,❌ 只说「回合未能完成」让人点开猜。
      const said = signInRequired ? undefined : upstreamSaid(fact.cause.message, fact.cause.data);
      return {
        outcome: {
          kind: 'error',
          reason: 'prompt_failed',
          ...(detail ? { detail } : {}),
          ...(signInRequired ? { signInRequired: true } : {}),
          ...(said ? { said } : {}),
        },
        provisional: !providerAuthored(fact.cause),
      };
    }
    case 'process-exit': {
      const exited = adapterExitDetail(fact.exit);
      const prior = fact.priorDetail?.trim() || undefined;
      const detail = prior && prior !== exited
        ? [exited, prior].filter(Boolean).join('\n')
        : exited;
      return {
        outcome: { kind: 'error', reason: 'process_closed', ...(detail ? { detail } : {}) },
        provisional: false,
      };
    }
    case 'connection-lost': {
      const detail = fact.failure?.message.trim() || undefined;
      return {
        outcome: { kind: 'error', reason: 'process_closed', ...(detail ? { detail } : {}) },
        provisional: false,
      };
    }
  }
}
