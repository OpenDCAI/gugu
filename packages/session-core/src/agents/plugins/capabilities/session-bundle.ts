import type { HarnessPlatform } from './platform';
import type { IPlatformModelBehavior } from './platform-model';
import type { McpServerOwner } from '../../../mcp/session-toggle';
import type { McpServer } from '@agentclientprotocol/sdk';
import semver from 'semver';
import { definePluginCapability } from '@gugu/session-shared/plugins';
import z from 'zod';
import type { GuguPermissionMode } from '../../../acp/models/permissions';

export type HarnessSessionSurface = 'acp' | 'tui' | 'app-server';
export type SessionpageSessionSurface = Extract<HarnessSessionSurface, 'acp' | 'tui'>;

/**
 * Static provider capability for short-lived platform credentials.
 *
 * This is deliberately separate from the host runtime lease record: it says how a harness
 * consumes a credential and which recovery shape is supported, never whether a token is valid.
 */
export type SessionCredentialLifecycle = {
  delivery:
    | 'child-process-env'
    | 'process-config'
    | 'child-process-env+process-config'
    | 'credential-helper'
    | 'credential-proxy';
  originalProcessRefresh: 'supported' | 'unsupported';
  recovery: 'reopen' | 'none';
  inferenceOwner: 'provider-process' | 'app-server-process-thread' | 'serve-process-descendants';
  reopenEntry: 'host-session-reload';
  /**
   * Whether a cross-billing model reload may replace the native provider session id.
   * `replace` = 原生会话记着的模型在另一条计费路上断言不掉,只能换一条新的原生会话;历史仍在咕咕的会话记录里。
   */
  sourceChangeSession: 'preserve' | 'replace';
};

/**
 * ACP 腿跑在一份咕咕自有的配置根上 —— 环境变量名 + 相对 `GUGU_HOME` 的路径段。
 *
 * 声明它的家,ACP 腿看见什么(provider、模型声明、登录态)由这份根决定,而不是用户自己的默认根;
 * 所以「这条腿能选哪些模型」的目录探针也必须指到这里,两处读的是同一个事实。
 */
export type AcpConfigRoot = {
  envVar: string;
  guguHomePath: readonly string[];
};

export type SessionCredentialLifecycleBySurface = Partial<
  Record<HarnessSessionSurface, SessionCredentialLifecycle>
>;

/**
 * 注入时机档 —— 分界线只有一条:**模型看见这条消息的时刻**(spec session-injection)。
 * `next-tool-call` = 当前循环的下一个工具边界就看见;`idle-only` = 整轮结束后才看见。
 * ❌ 不按"字节被谁收下、排在哪个队列"分档:那是管子,不是可观测行为。
 */
export type SessionpageInjectionTiming = 'next-tool-call' | 'idle-only';

/**
 * 一家 harness 在一个 sessionpage surface 上的注入时机声明。
 *
 * 声明只能来自专项证据(#4472 判据:走 provider 自己的控制通道、不另起 provider 进程、
 * 第一轮里的模型看得见后来消息,三条同时成立),`evidence` 必须是可复核坐标
 * (URL 或 `owner/repo@sha`,见 {@link hasCitedEvidence})——与 `sessionTuiInterrupt` 同一道闸:
 * 填不出出处 = 还没取证 = 这一格不该声明,让它落回缺省的最保守 `idle-only`。
 */
export interface SessionpageInjectionDeclaration {
  timing: SessionpageInjectionTiming;
  evidence: string;
  /**
   * 这一格的**已知偏差** —— 实测到、但两档模型装不下的形状,记在声明上让读者看得见:
   * 例如「稳定晚一个工具边界才可见」(仍属 next-tool-call,但与'下一个边界'的字面有稳定偏差)、
   * 「busy 时第二条 prompt 被 4xx 且 SDK 吞成静默成功 ⇒ ❌ 不可升档」(缺陷,声明必须停在 idle-only)。
   * ⚠️ 它**不是第三档**:分界线只有「模型看见它的时刻」(owner 裁决),路由只读 `timing`;
   * 这一格只是警示标签,防止「droid 的绿」和「claude 的晚一个」在声明面上看起来一样。
   */
  deviations?: string;
}

/**
 * 这家 harness 的**可见终端**对用户键入的解析约束。
 *
 * 一次提交是**两个**用户事件:先是正文,再是提交键。宿主把两者写进 harness 的 stdin 时,如果它们
 * 挨得足够近以至于 harness 一次 read 就全收走,而这家的 TUI 又拿提交键去结算一个尚未收下正文的
 * composer,那么**整条提交就没了 —— 没有报错、没有回显、什么都不留**。这不是投递层的忙闲探测,
 * 也不是「等它准备好」:正文与提交键照旧立即写出,只是保持成两个可分辨的事件。
 *
 * 缺席 = 这家没有这条约束 ⇒ 零延迟,与今天逐字节直写完全一致。**❌ 不给通用默认值**:没有哪家
 * 该为别家的解析缺陷付延迟,谁量到谁声明。
 */
export interface SessionpageTerminalInputDeclaration {
  /**
   * 提交键与它前一次写入之间必须保持的最小间隔(毫秒)。取值要**大于实测的失败上界**,
   * 并把测量本身写进 `evidence`。
   */
  submitSeparationMs: number;
  /** 可复核坐标(URL 或 `owner/repo@sha`),与 injection 同一道闸。 */
  evidence: string;
  /** 阈值是怎么量出来的、怎么重量 —— 一个带出处的常数是工程,一个裸 sleep 是迷信。 */
  measurement: string;
}

export interface SessionpagePromptInputDeclaration {
  multiline: 'bracketed-paste' | 'plain';
  evidence: string;
}

export interface SessionpageSessionIntegration {
  identity: 'addressable' | 'none';
  messageTransport: 'router' | 'local-session' | 'none';
  /**
   * 入站可达性 —— 这条腿**收不收得进**消息。与 `identity`(给不给身份)和出站能力(MCP 工具进没进
   * 模型的工具表)**正交**:三者可以任意组合,而此前的词表说不出「有身份 · 能往外发 · 收不进来」那一格。
   *
   * 为什么必须单独一轴,而不是把 `messageTransport` 改成 `'none'`:后者被
   * `canProvisionSessionpageAgent` 同时读着,一说"无入站"就连**身份供给**一起否掉,
   * 把 #4403 买到的 MCP 载体与身份自述一并丢掉(kimi tui 实例,#4670)。
   *
   * 也不能从 `capabilities.prompt.kind === 'none'` **推**出来:那是 provider 级的**启动首句**通道声明,
   * 而这一轴是 per-surface 的入站事实;`none` 有两种成因(无状态一次性引擎 / 实测没有非-PTY 通道),
   * 其中前者并不蕴含"收不进"。跨轴推断正是本仓在注入档位上明令禁止的那种(spec session-injection)。
   *
   * 缺席 = `'deliverable'`。⚠️ 这条默认与本仓「缺席 = 最保守」的惯例**相反**,是有依据的:
   * 现存 51 个 `addressable` 格的入站早已被各自的投递读数证实,把它们一律降成"收不进"才是编造。
   * 由 meta 判据钉住:声明 `'none'` 的格必须是显式写下的。
   */
  inbound?: 'deliverable' | 'none';
  hostAdapter?: Exclude<SessionpageHostAdapter, 'provider-session-bundle'>;
  /** 见 {@link SessionpageTerminalInputDeclaration};只有可见终端(tui)这一行用得上。 */
  terminalInput?: SessionpageTerminalInputDeclaration;
  /** 多行正文在可见终端中的编码；缺席保持 bracketed-paste 兼容默认。 */
  promptInput?: SessionpagePromptInputDeclaration;
  /**
   * 消息注入时机 —— 与 identity/messageTransport 同一张每家一行的表的第三轴:
   * 前两轴回答「能不能被寻址/能不能收消息」,这一轴回答「模型什么时候看见」。
   * 缺席 = 未判定 → 内核按最保守的 `idle-only` 处理(❌ 不推断升档)。
   * 升档 = 改这一格并携证据,内核与注入下水道零 diff(spec session-injection 的加家判据)。
   */
  injection?: SessionpageInjectionDeclaration;
  /**
   * 这一格为什么关着 —— 一句给用户看的、provider 自述的原因,在 fail-loud 口(创建会话页的
   * `messageTransportError`)原样接在通用错误后面。缺席 = 沿用通用错误、不加原因(现存所有格皆如此)。
   *
   * 为什么是**自由字符串**而不是复用 units 的结构化 {@link Degradation}:格的关闭跨了 code 枚举
   * 说不出的类别。grok 就是活证——tui 那格是「未从发布源实测过」(≈unverified),而 acp
   * 那格能力齐备(mcp/model/autonomy/promptBlocks 全 native),只是首轮路由还没接、要与 #4653 链
   * 一起落地,是**被门控**而非 unverified/upstream-broken。硬套 code 只能撒谎。⇒ 单元用 code、
   * 格用一句话,是两笔不同的账,❌ 别把 unit 的词表铺过来。
   */
  reason?: string;
}

/**
 * 一个 surface 的运行时兼容性声明。
 *
 * 只有 floor 一种形态 —— ❌ 不提供「恰好等于某个 patch 版本」的档。曾经有过（`exact-version`
 * 钉死 opencode `1.18.18`），它把「我们只测过这一版」编码成了「只有这一版能用」：装 `1.18.16`
 * 的用户读不出模型清单，装 `1.18.19` 的**同样**被拒。upstream 两三天发一个 patch，这种闸每
 * 发一次版就把全体用户锁在门外一次，是一条注定过期的护栏。
 *
 * floor 的语义是「低于此版本已知不可用」，因此它只该在拿到「某版本确实坏了」的证据时上移；
 * ❌ 不因为「我们只在某版本上测过」就把 floor 抬到那一版。
 */
export type SessionRuntimeCompatibility =
  | {
      kind: 'semver-supported-floor';
      supportedFloor: string;
      versionArgs: readonly string[];
      /** Probe the harness itself (the default) or the interpreter that launches it. */
      runtime?: 'harness' | 'node';
    }
  | {
      kind: 'semver-supported-ranges';
      supportedRanges: readonly string[];
      versionArgs: readonly string[];
      /** Probe the harness itself (the default) or the interpreter that launches it. */
      runtime?: 'harness' | 'node';
    };

/** Host transport topology for a session-TUI session; provider selection remains in the registry. */
export type SessionTuiHostAdapter =
  | 'provider-session-bundle'
  | 'claude-rendezvous-v1'
  | 'codex-app-server-v1'
  | 'kimi-web-rest-v1'
  | 'droid-daemon-v1'
  | 'opencode-serve-attach-v1';

export type SessionpageHostAdapter = SessionTuiHostAdapter;

export type SessionTuiDeliveryToolNames = {
  message: string;
};

export type Degradation = {
  code: 'unsupported-channel' | 'violates-zero-residue' | 'upstream-broken' | 'unverified';
  reason: string;
};

/** `X`:某一格自己多带的字段(只有 `mcp` 用,见 {@link McpDeliveryExtra})。 */
export type UnitDelivery<C extends string, X extends object = {}> =
  | ({ kind: 'native'; channel: C } & X)
  | { kind: 'none'; degraded: Degradation };

export type McpDeliveryExtra = {
  /**
   * 这条腿收得下哪几种传输。缺席 = stdio 和 http 都收。
   * (antigravity 终端腿:共用的 `mcp_config.json` 里写不了每条会话的 env,只收 http。)
   */
  transports?: readonly ('stdio' | 'http')[];
};

/**
 * 一个能力单元的投递声明。
 *
 * 扁平写法(`{kind:'native'|'none'}`)= **两条腿同一个答案**,绝大多数家都是这样。
 *
 * `{kind:'per-surface'}` 用于**两条腿答案确实不同**的家 —— 不是为了灵活,是因为
 * 两条腿能递进去的东西本来就不一样(终端腿咕咕能定启动参数,协议腿只能用协议给的字段),
 * 而 behavior `agent-config-boundary` 明令 **❌ 不许借另一条腿的通道假装它有**。
 * 没有这一格,一家「PTY 腿真送到了、ACP 腿什么都没送」就只能二选一地撒谎:
 * 报 native 是替 ACP 腿吹牛,报 none 是把 PTY 腿真做到的事抹掉。
 *
 * ⚠️ 读取一律经 {@link resolveUnitDelivery},❌ 别直接读 `.kind`/`.channel` ——
 * `per-surface` 的 `.kind` 既不是 `'native'` 也不是 `'none'`,直接判会把「两条腿都通」
 * 静默读成「没通」。
 *
 * ⚠️ 这一格**只**开给 `units`。`coexistence` 那八条仍是单值 {@link UnitDelivery}:
 * 它们今天确实也有按腿分叉的实情(kimi 的注释里就写着「session-TUI 腿这四条一条都没有」),
 * 但那是**另一笔账**,要单独测量后再开 —— ❌ 别顺手把这一格铺过去,那等于在没有读数的
 * 情况下把八维一起改成可分叉,把「还没量」伪装成「已经分好了」。
 */
export type SurfaceScopedUnitDelivery<C extends string, X extends object = {}> =
  | UnitDelivery<C, X>
  | {
      kind: 'per-surface';
      surfaces: Partial<Record<HarnessSessionSurface, UnitDelivery<C, X>>>;
    };

/**
 * 取这条腿上的实际投递。
 *
 * `per-surface` 里缺了该腿 = 作者漏写(descriptor 的 `surfaces` 已经声明这条腿存在),
 * 按铁律 fail loud 报错,❌ 不落回 `none` —— 那会把一个漏写伪装成一条如实的降级记录。
 */
export function resolveUnitDelivery<C extends string, X extends object = {}>(
  delivery: SurfaceScopedUnitDelivery<C, X>,
  surface: HarnessSessionSurface
): UnitDelivery<C, X> {
  if (delivery.kind !== 'per-surface') return delivery;
  const leaf = delivery.surfaces[surface];
  if (leaf === undefined) {
    throw new Error(
      `per-surface unit delivery is missing surface '${surface}'`
    );
  }
  return leaf;
}

/**
 * 这一家这条腿收不收咕咕经能力包送的 MCP、收哪几种传输(资源库 → MCP 勾选与送达都按它算)。
 * 没有 descriptor、没声明这条腿、或者 `units.mcp` 在这条腿上不是 native = 收不到。
 */
export function sessionMcpDeliveryOn(
  descriptor: Pick<SessionBundleDescriptor, 'surfaces' | 'units' | 'sessionpage'> | undefined,
  leg: 'acp' | 'tui'
): { channel: false } | { channel: true; transports: readonly ('stdio' | 'http')[] } {
  if (!descriptor) return { channel: false };
  // app-server 那类家(codex)的终端腿挂在 `app-server` 这个 surface 上(`declaresSessionTuiLeg`)。
  const surface: HarnessSessionSurface =
    leg === 'tui' && !descriptor.surfaces.includes('tui') && declaresSessionTuiLeg(descriptor) ? 'app-server' : leg;
  if (!descriptor.surfaces.includes(surface as never)) return { channel: false };
  const delivery = resolveUnitDelivery(descriptor.units.mcp, surface);
  if (delivery.kind !== 'native') return { channel: false };
  return { channel: true, transports: delivery.transports ?? ['stdio', 'http'] };
}

/**
 * 这条腿上的会话提示块是不是**每次起进程都要重新投递**。
 *
 * 别的通道把提示块在新建时交出去、之后随引擎自己的会话记录走,续跑时再递一遍就是重复;
 * `'hook-ephemeral'` 每次调用现插、从不进历史 —— 续跑时不递,身份就没了。
 * 宿主据此决定续跑时带不带身份块,❌ 别在调用点按 provider 名字分支。
 */
export function promptBlocksReplayedEverySpawn(
  descriptor: Pick<SessionBundleDescriptor, 'surfaces' | 'units'>,
  surface: HarnessSessionSurface
): boolean {
  if (!descriptor.surfaces.includes(surface as never)) return false;
  const delivery = resolveUnitDelivery(descriptor.units.promptBlocks, surface);
  return delivery.kind === 'native' && delivery.channel === 'hook-ephemeral';
}

/** Resolve the static credential lifecycle declaration for one provider surface. */
export function resolveSessionCredentialLifecycle(
  descriptor: SessionBundleDescriptor,
  surface: HarnessSessionSurface,
): SessionCredentialLifecycle | null {
  return descriptor.credentialLifecycle?.[surface] ?? null;
}

/**
 * 这个单元是不是**每一条声明了的腿上都** native。
 *
 * 给「咕咕集成档」这类**整家**的问题用:一条腿通、另一条腿不通,整家就不算通 ——
 * ❌ 别改成 `some`,那就是让强的那条腿替弱的那条背书,正是 behavior 禁的那件事。
 */
export function unitDeliveryIsNativeEverywhere(delivery?: {
  kind?: string;
  surfaces?: Record<string, { kind?: string }>;
}): boolean {
  if (delivery?.kind === 'native') return true;
  if (delivery?.kind !== 'per-surface') return false;
  const leaves = Object.values(delivery.surfaces ?? {});
  return leaves.length > 0 && leaves.every((leaf) => leaf?.kind === 'native');
}

/**
 * 这一格**至少有一条腿**是 native。
 *
 * 与上面那个的分工要分清,❌ 别混用:
 *  · `…Everywhere` 回答「整家这一维通不通」——用于咕咕集成档那类**对外承诺**的判据;
 *  · `…Anywhere`   回答「这家有没有自己的物化器值得调」——用于**路由**,不是投递声明。
 *
 * ⚠️ 存在这个函数是因为按腿声明落地时踩过一次:`capability-bundle.ts` 的
 *    `declaresProviderMaterializedDelivery` 是扁平读 `kind === 'native'` 的,而 oh-my-pi 把
 *    最后一格扁平 native(mcp)改成按腿之后就**一格都不剩** ⇒ 它的终端腿当场失去物化器、
 *    会话起不来(CI 抓到)。路由判据要问的是「有没有」,不是「每条腿都有」。
 */
export function unitDeliveryIsNativeAnywhere(delivery?: {
  kind?: string;
  surfaces?: Record<string, { kind?: string }>;
}): boolean {
  if (delivery?.kind === 'native') return true;
  if (delivery?.kind !== 'per-surface') return false;
  return Object.values(delivery.surfaces ?? {}).some((leaf) => leaf?.kind === 'native');
}

/**
 * 这家**对外提供**终端腿吗 —— 即 `buildPromptCommand` 会不会真的替它拉起一条 pty。
 *
 * ⚠️ 判据不是「有没有 `behavior.prompt.buildCommand` 这个函数」。两者会分叉:一个家可以
 *    留着构造函数(登录那条路要用、或那条腿是**暂不开启**的特性)却不声明这条腿,此时
 *    `PluginHost.buildPromptCommand` 会先 `capability-unsupported` 挡回去,那个函数
 *    **运行期永远不会被调用**。拿「函数在不在」当判据,就会去要求一条到不了的腿。
 *
 * 只此一处定义:这条规则此前在 plugin-host / registry / capability-bundle / 各测试里各写一遍,
 * 抄漏一处就是判据与运行时说两套话。
 */
/**
 * 这一格声明的注入时机 —— 「忙时这家能不能把一句话插进当前回合」的**唯一**读取口:投递、扩展插话、
 * 排队提示的立即发送都读它(#6574)。声明缺席 = 未判定 ⇒ 最保守的 `idle-only`,❌ 从别的格推断升档。
 * 这家具体怎么插(原生 steering、并发 prompt、工具边界打断)是运行时的事,不在这里分。
 */
export function declaredInjectionTiming(
  integration: Pick<SessionpageSessionIntegration, 'injection'> | undefined,
): SessionpageInjectionTiming {
  return integration?.injection?.timing ?? 'idle-only';
}

export function declaresSessionTuiLeg(descriptor: {
  surfaces: readonly string[];
  sessionpage: Record<string, unknown>;
}): boolean {
  if (descriptor.surfaces.includes('tui')) return true;
  // app-server 那类家没有独立的 'tui' surface,终端腿挂在 sessionpage 上。
  return descriptor.surfaces.includes('app-server') && Boolean(descriptor.sessionpage['tui']);
}

/**
 * 共处能力 —— 一个会话**已经跑起来之后**,咕咕能不能看住它、打断它、读回它。
 *
 * 与 `units` 的分界:`units` 建模的是咕咕往引擎里**推**什么(MCP、env、模型、提示块的投递通道);
 * 这八条建模的是咕咕对一个活着的会话**能做什么**。两者语义不同,混进同一个字段会让「通道」
 * 和「能力」互相冒充。
 *
 * 为什么八条一起建:它们不是八件事,是同一件事(咕咕的 harness 抽象只覆盖了接入、没覆盖共处)
 * 的八个切面。分期补,等于把「抽象不完备」分八次暴露 —— 那正是要解决的问题本身(#3889)。
 *
 * ⚠️ 声明的是**咕咕接没接通**,不是**厂商有没有**。厂商侧的事实是外部证据,归
 * gugu-base `notes/harness-capability-evidence/harness-capability-evidence.json`
 * (来自 #3889 的 36 家官方调研)。对照这两者:
 * - 厂商有、咕咕 `none + unverified` = 待办(诚实)
 * - 厂商有、咕咕 `none + unsupported-channel` = **把「我们没接」说成「它做不到」**,违规
 * - 厂商无、咕咕 `native` = 声明了做不到
 */
export interface SessionCoexistence {
  /**
   * 会话暂停 —— agent 停下手里的活,**进程活着、会话还在、能接着说**。
   *
   * ⚠️ 三级术语不许混:暂停(本条)/ 停止(进程没了,输出与状态留着,能否恢复由 history 管)/
   * 移除(全清)。混用会直接导致比错 —— 拿 TUI 的 stopSession 去跟 ACP 的协议 cancel 并排比,
   * 根本不在一级上。
   */
  pause: UnitDelivery<'protocol-cancel' | 'interrupt-key' | 'process-signal'>;

  /**
   * 读侧观测 —— harness 自己报不报「本轮在飞」。
   * 声明的是「咕咕那套会话状态词汇里,哪些它观测得到」,不是「它有没有输出」。
   */
  observability: UnitDelivery<'stream-json' | 'acp-update' | 'event-stream' | 'rpc-stream'>;

  /**
   * 能不能问用户(澄清型) —— agent 想问「选 A 还是 B」时有没有一条通到人的路。
   */
  askUser: UnitDelivery<'mcp-elicitation' | 'native-tool' | 'permission-ask'>;

  /**
   * 能报出什么(MCP / hooks / skill / slash / plugin)。
   * 通道区分获取方式:`config-scan` 扫配置文件(不用启引擎)、`running-engine` 问运行中的引擎
   * (得先开会话)。❌ 读「咕咕注进去的」不等于读「用户自己的」—— 只声明后者。
   */
  introspection: UnitDelivery<'config-scan' | 'running-engine'>;

  /**
   * 历史持久化 —— 咕咕能不能把它的会话历史读回来。
   * ⚠️ 「它自己存到什么程度」(决定 resume 后上下文完不完整)是另一回事,不在本条声明。
   *
   * 唯一判据:core 的 `transcriptSources/` 注册表里有没有它那一份 spec
   * (packages/core/src/local/agent/transcriptSources/index.ts)。声明 native 之前先去加 spec —— 两侧由
   * `tests/unit/core/local/transcriptSources.test.ts` 双向对账,单方面改这一行会红。
   * ⚠️ `'server'` 按 #3889 的口径**不该出现在这里**:云端历史咕咕管不到人家的云,
   * 声明它等于承诺一件做不到的事(纯云端遥控壳那一类就属此列 —— 历史例子 jules 已随 #6097 删)。
   * `'sqlite'` 通用层今天**还没实现**读取路径 —— 声明前先看 core 的
   * `transcriptSource.ts` 里 `TranscriptStorageChannel` 的说明。
   */
  history: UnitDelivery<'jsonl' | 'sqlite' | 'server'>;

  /**
   * 定时自动化 —— 与 hooks 正交(hooks 是「出了 X 就跑」,cron 是「到点就跑」)。
   * ⚠️ `cloud` 对咕咕基本等于没有 —— 咕咕管不到人家的云,声明它只为如实记录,不为依赖。
   */
  cron: UnitDelivery<'local' | 'cloud'>;

  /**
   * 读 agent 的 todo / plan。
   * ⚠️ 结构化数组与纯 markdown 是两回事;另注意「原生有而 ACP 桥不发」的情形确实存在。
   */
  todo: UnitDelivery<'acp-plan' | 'structured-event' | 'markdown'>;

  /**
   * agent memory —— 磁盘上 agent **自己会去读**的文件。
   * ❌ 别跟 `promptBlocks` 混:那是咕咕每次会话注入的提示块,这是引擎自己的记忆文件。
   */
  memory: UnitDelivery<'agents-md' | 'vendor-file'>;
}

export type SessionCoexistenceDimension = keyof SessionCoexistence;

export const SESSION_COEXISTENCE_DIMENSIONS = [
  'pause',
  'observability',
  'askUser',
  'introspection',
  'history',
  'cron',
  'todo',
  'memory',
] as const satisfies readonly SessionCoexistenceDimension[];

/**
 * 投递单元的维度名 —— 与 `SESSION_COEXISTENCE_DIMENSIONS` 同一套路、同一目的:
 * 给「这个概念在抽象里到底有没有槽位」提供一个**编不出来的**判据。
 *
 * `satisfies` 把每一项钉在 `units` 的真实键上,写错一个字母当场不编译。
 * 答案键的维度想声称「我在抽象里有落点」,就得指得出落在哪个具名槽位,
 * 而不是往一张手写字符串表里贴个名字。
 */
export type SessionBundleUnitDimension = keyof SessionBundleDescriptor['units'];

export const SESSION_BUNDLE_UNIT_DIMENSIONS = [
  'mcp',
  'env',
  'model',
  'autonomy',
  'promptBlocks',
] as const satisfies readonly SessionBundleUnitDimension[];

const NOT_WIRED: Degradation = {
  code: 'unverified',
  reason: '咕咕尚未接通这一维;厂商侧有没有见 #3889 的官方证据矩阵,勿据本条推断厂商不支持',
};

/**
 * 共处能力的**基类** —— 每一维都是「咕咕还没接」。
 *
 * 这是诚实的默认,不是绿灯:`unverified` 说的是「咕咕没接/没验」,**不是**「厂商做不到」。
 * ❌ 谁都不许把基类里的 `unverified` 改写成 `unsupported-channel` 来「解释」缺失 —— 那正是
 * #3889 方法论红线挡的事:本仓 grep 不到只能证明咕咕没接。
 *
 * 各家适配器只覆盖**自己真接通了**的那几维(`resolveSessionCoexistence` 做合并),
 * 没覆盖的自动落回基类。这样加一维不会同时打破 45 处 descriptor,各家可以各自上线。
 */
export const BASE_SESSION_COEXISTENCE: SessionCoexistence = {
  pause: { kind: 'none', degraded: NOT_WIRED },
  observability: { kind: 'none', degraded: NOT_WIRED },
  askUser: { kind: 'none', degraded: NOT_WIRED },
  introspection: { kind: 'none', degraded: NOT_WIRED },
  history: { kind: 'none', degraded: NOT_WIRED },
  cron: { kind: 'none', degraded: NOT_WIRED },
  todo: { kind: 'none', degraded: NOT_WIRED },
  memory: { kind: 'none', degraded: NOT_WIRED },
};

/** 把某一家的子类声明合到基类上;没声明的维度落回基类(= 尚未接通)。 */
export function resolveSessionCoexistence(
  declared?: Partial<SessionCoexistence>
): SessionCoexistence {
  return { ...BASE_SESSION_COEXISTENCE, ...declared };
}

export type ExtensionDelivery =
  | {
      kind: 'declarative-bundle';
      format: 'claude' | 'codex';
      /**
       * 这一包**怎么被引擎激活**。`'skill-roots'` = 包里只有 skill 被铺开,而且不进任何 home:
       * 咕咕在自己的目录里给这条会话建一个 skill 根(`<extension>-<skill>` 链到扩展目录),
       * 由引擎在运行时登记成额外的 skill 根 —— codex 的 app-server `skills/extraRoots/set`。
       * 合成 home 会毁掉授权,用户自己的 home ❌ 动,所以 mcp / hooks 不走这条。
       */
      activation: 'session-dir' | 'isolated-home' | 'skill-roots';
      carries: { mcp: 'manifest' | 'none'; skills: 'manifest'; hooks: 'manifest' | 'none' };
    }
  | {
      kind: 'event-module';
      format: 'opencode';
      scope: 'workspace';
      carries: { mcp: 'none'; skills: 'none'; systemPrompt: 'none'; hooks: 'module' };
    }
  | {
      kind: 'event-module';
      format: 'pi';
      scope: 'workspace';
      carries: { mcp: 'none'; skills: 'none'; systemPrompt: 'module'; hooks: 'module' };
    }
  | { kind: 'none'; degraded: Degradation };

/**
 * 出处必须落到一个**可复核的坐标**上,而不是一句说辞。
 *
 * 只接受两种形态:
 * - URL —— 官方文档 / 键位表 / 上游源码页(要求带点的主机名,`https://x` 这种占位不算);
 * - `owner/repo@<sha>` —— 上游源码的某一次提交,7–40 位 hex。
 *
 * 为什么必须机器判而不是靠 review:`evidence: z.string().min(1)` 只挡得住空串,挡不住
 * 「实测」「应该是」「同 claude」—— 这三种写法在评审里都读得过去,却在半年后上游改了键位时
 * **无从复核**。而键位填错的代价是往 pty 写错字节:杀掉用户正在跑的会话,界面上还报「已暂停」。
 *
 * ⚠️ 它判的是「有没有坐标」,判不了坐标是不是真的 —— 编一个 URL 照样过。这条闸的作用是把
 * 「懒得取证」和「取了证」分开,不是替人核对。❌ 别因为它挡不住伪造就把它放宽。
 */
export const EVIDENCE_CITATION_PATTERN =
  /(?:https?:\/\/[^\s/]+\.[^\s/]+\S*)|(?:[\w.-]+\/[\w.-]+@[0-9a-f]{7,40}\b)/;

/** 这条出处串里有没有可复核的坐标(URL 或 `owner/repo@sha`)。 */
export function hasCitedEvidence(evidence: string): boolean {
  return EVIDENCE_CITATION_PATTERN.test(evidence);
}

/**
 * TUI 腿的中断键 —— 宿主往 pty 写的原始字节。
 *
 * ⚠️ 三级术语不许混(见 `SessionCoexistence.pause` 的注释):这里做的是**暂停** —— agent 停下
 * 手里的活,进程活着、会话还在、能接着说。它**不是** `stopSession`(进程没了),更不是删除。
 *
 * ⚠️ 键位是**厂商事实**,必须逐家取证再填:各家把 Esc / Ctrl-C 绑到了不同语义上 —— 有的家单按
 * Esc 只清输入框、双击才中断,有的家 Ctrl-C 直接退进程。填错的代价不是「没反应」,是**把用户
 * 的会话杀了**却在界面上报「已暂停」。因此本类型强制带 `evidence`:填不出出处 = 还没取证 =
 * 这一家不该声明 `pause`。
 */
export interface SessionTuiInterrupt {
  /** 原始字节序列。ESC = `'\u001b'`,Ctrl-C = `'\u0003'`。 */
  sequence: string;
  /** 连按次数。缺省 1;>1 用于「单按只清输入框、双击才中断」的家。 */
  presses?: number;
  /** 连按之间的间隔(毫秒)。`presses > 1` 时必填 —— 连着写两个字节多半会被当成一次按键。 */
  intervalMs?: number;
  /**
   * 这个键位的**厂商出处**:官方文档 URL / 键位表 / 源码位置,外加取证日期。
   *
   * 不是形式主义:护栏里写死的外部事实会过期(上游改键位不会通知我们),留出处才让下一个人
   * 有得核。❌ 不许填「实测」「应该是」这类无从复核的话。
   */
  evidence: string;
}

/**
 * 终端里的原生提问选择器能从咕咕的提问卡回答(#6798、#7035):宿主往 pty 写一次 `cancel` 关掉选择器,
 * 等记录里这道题有了结果,再把用户的回答当一条普通消息发给 agent。拒答 = 只关掉选择器。
 * 终端前的人照旧用原生选择器,这条路不碰它。
 *
 * 只声明一个键:取消的语义每家都有,按键的布局才是各家各样的 —— ❌ 再按选项去编键序。
 */
export interface SessionTuiQuestionAnswer {
  /** 关掉选择器的那个键的字节(Claude 是 Esc)。 */
  cancel: string;
  /** 写完取消键后,终端连续这么久没有新输出才算重画完(毫秒)。 */
  settleMs: number;
  /** 最多等这么久的重画(毫秒);等不到 ⇒ 报错,不发回答。 */
  maxWaitMs: number;
  /** 取消键的厂商出处,规则同 `SessionTuiInterrupt.evidence`。 */
  evidence: string;
}

/**
 * 这家智能体的**配置根** —— 它在用户机器上放登录态、偏好、skills、历史的那个目录。
 *
 * 声明了它,咕咕就为这家持有**自己的一份**(独立 home):首次为它起会话时从用户那份
 * **整份复制**过来,此后两份彻底分家 —— 不同步、不合并、不回读、不写回。
 * 见 behavior `agent-config-boundary`。
 *
 * ## ⚠️ 「独立 home」≠「合成 home」,❌ 别用同一个词指两件事
 *
 *  · **合成 home**(已否决):每条会话临时造一个**空**目录当配置根,会话结束就扔 ——
 *    用户的登录态、skills、历史全看不见,`sessions/` 每次新 uuid ⇒ 没有可续的会话。
 *  · **独立 home**(本字段):**持久**、**整份复制**来的、**每家一份**。第一次在咕咕里
 *    打开它,与用户自己打开它,看到的是同一个东西。
 *
 * ## ❌ 不硬编码任何一家
 *
 * 通用机制只认这里声明的两个事实(变量名 + 用户那份的位置),kimi 只是第一个声明的。
 * 加一家 = 加一条声明,❌ 不是在通用代码里加一个 `if (providerId === 'x')`。
 */
/**
 * 咕咕把设置递给引擎，只有两条路。哪一家走哪条，见 product spec
 * 的「两条路：运行时注入，与托管配置根」。
 *
 * · `'runtime'` —— **默认**。启动参数 / 环境变量 / 每会话临时文件。性质是**不落地**：
 *   进程退出，用户那侧与咕咕这侧都不留新增产物。
 * · `'managed-config-root'` —— 咕咕在自己目录里为这一家**长期持有**一份配置根。
 *   只给**没有运行时通道**的那几家；这不是残留，是那一类引擎的正常形态。
 *
 * ⚠️ 放进 `'managed-config-root'` 的举证责任在提议方：拿实测证明这一家的运行时通道
 *    递不进这项设置。「没试过」「顺手」「隔壁那家也这么做」都不算。
 */
export type AgentInjectionMode = 'runtime' | 'managed-config-root';

export interface AgentConfigRoot {
  /**
   * 把这家的配置根挪走的环境变量名(如 `KIMI_CODE_HOME` / `CODEX_HOME` / `CLAUDE_CONFIG_DIR`)。
   *
   * ⚠️ 它必须同时在透传白名单里(这一家的 `shellEnv.passThrough`),否则咕咕算出来的路径**递不到**子进程 ——
   * 登录会写用户那份、会话读咕咕那份,两者永不相遇。有元测试盯着这条。
   */
  envVar: string;
  /** Whether the host should override the child process environment with this root. */
  injectEnv?: boolean;
  /** 用户默认那份的位置,**相对 OS home**(如 `.kimi-code`)。❌ 不写绝对路径。 */
  userPath: string;
  /**
   * 分家时**不带过来**的条目 —— 相对配置根,**必答**,❌ 无默认。
   *
   * ## 为什么是「排除」不是「挑选」
   *
   * 先做的是挑选(白名单),被判否 —— **它的失败方向是错的那一边**:
   *  · 漏排一个**缓存/程序**目录 ⇒ 多拷点垃圾。可测量、可回收、看得见。
   *  · 漏挑一个**配置**条目 ⇒ 用户那项设置没跟过来,**不报错、没日志**,
   *    用户只会觉得咕咕把他的东西弄丢了 —— 而 product spec
   *    要的是「用户在咕咕外面配好的,在咕咕里就该是同一个」。
   *
   * 而引擎的配置面由上游定义、随版本增删 ⇒ 白名单**结构上**跟不上:换个版本多出一个
   * 配置文件,清单不会自己长出来。实测教训:第一版按 mac1 那台 `~/.kimi-code` 的目录布局
   * 挑清单,漏了 `skills/`、`AGENTS.md`、`SYSTEM.md`、`agents/` 四条 —— 它们只在用户
   * **用过那个功能之后**才存在,那台一个都没有。
   *
   * ⇒ 默认全带,这里只列**不是用户配置**的那些(引擎自己会重新长出来的,或咕咕自己会写的)。
   *   这个集合小得多、跨版本也稳定得多(`bin/` `cache/` `logs/` `tmp/` 这类名字不太变),
   *   而且真漏排一条的代价是多占点盘,**不是丢用户数据**。
   *
   * ## 语义
   *
   *  · 条目可以是文件也可以是目录;目录**整棵**跳过。
   *  · 空数组是合法答案(这一家的配置根里确实没有派生物)—— 但它必须是**答出来的**,
   *    ❌ 不给默认值:没人答过 = 没人看过这一家的配置根里有什么。
   *  · 判据按**相对配置根的路径**匹配,`/` 分隔。
   *
   * ⚠️ 每条都要 `evidence` 说清它凭什么**不算**用户配置 —— 排错一条就是静默丢数据,
   *    与漏挑一条同罪;区别只在于这个方向的错要少得多、也更好发现。
   */
  carryExclusions: readonly AgentConfigRootCarryExclusion[];
  /**
   * 这两条事实的出处 —— 解析式在哪、或官方文档哪一页。
   * ⚠️ 写死一个目录名而不给出处,下个版本它改了名就没人知道。
   */
  evidence: string;
  /**
   * 首次铺这份独立 home 时**顺手写下**的文件 —— 相对配置根,已存在就不动。
   *
   * 用途:引擎的「首次运行」询问在独立 home 里会**重新问一遍**(它们按目标目录记账,
   * 而咕咕这份是个新目标)。这些问题往往默认答案就是错的 —— kimi 的
   * 「Migrate from kimi-cli」默认停在「Migrate now」,而它会拿用户的旧配置盖掉咕咕
   * 刚写好的平台模型。⇒ 由这一家声明「这些问题在我这份 home 里已经答过了」。
   *
   * ⚠️ 这是**声明式**的,一家一条 —— ❌ 别在 `ensureAgentHome` 里按 providerId 分支:
   *    独立 home 不会只有一家用(owner 2026-08-28 明说)。
   * ⚠️ 每条都要 `evidence`:这些是引擎的**内部**约定,文档里通常没有,只能靠实测 ——
   *    没有出处的话,下个版本它换了机制没人知道该去哪儿复查。
   */
  seedFiles?: readonly AgentConfigRootSeedFile[];
  /** Dynamic first-run/trust state applied by the shared host write port per spawn. */
  firstRunState?: readonly AgentFirstRunState[];
}

/**
 * 用户自己那份配置根(配置、登录态、会话记录都在下面)。与托管的 `configRoot` 无关:runtime 的家也有它。
 * `envVar` 覆盖默认的 `~/<userPath>`;候选只经 `nativeHomeRoots`(helpers)算,❌ 各处自己拼。
 */
export interface NativeHome {
  envVar: string;
  /** 相对 OS home,如 `.codex`。 */
  userPath: string;
  evidence: string;
}

/**
 * 用户 shell 里**这一家自己的**环境变量名(品牌前缀、它自己的数据根、它自己的模型旋钮)。
 * 多家共用的厂商 SDK 约定(`OPENAI_API_KEY`、`AWS_*`、`GOOGLE_*`…)不在这里,在 session-core `agent-env.ts`。
 * 宿主取全部注册插件的并集:白名单对每条会话一样(一个名字只是「这一家会读」,别家不读也无害)。
 */
export interface ShellEnv {
  /** 从用户 shell 透传给 agent 进程。 */
  passThrough?: readonly string[];
  /** 咕咕自己给这一家的那几格:用户 shell 里同名的 export ❌ 透传(否则面板写着 A、跑起来是 B)。 */
  denied?: readonly string[];
}

export interface AgentConfigRootCarryExclusion {
  /** 相对**配置根**的路径(如 `bin`、`cache`、`mcp.json`)。❌ 绝对路径、❌ `..`。 */
  path: string;
  /**
   * 它凭什么**不算**用户配置 —— 实测出处,或官方文档哪一页。
   * 两类正当理由:① 引擎自己会重新长出来(缓存/日志/下载的二进制/临时目录);
   * ② 咕咕自己会往这份配置根写它(带用户那份过来只会被覆盖)。
   * ⚠️ ❌ 不接受「看着不重要」「体积大」:体积大不是判据,**能不能重新长出来**才是。
   */
  evidence: string;
}

export interface AgentConfigRootSeedFile {
  /** 相对**配置根**的路径(如 `.skip-migration-from-kimi-cli`)。❌ 绝对路径、❌ `..`。 */
  path: string;
  /** 文件内容。存在性本身就是信号时给空串。 */
  content: string;
  /** 这个文件是怎么测出来的 —— 谁在什么条件下写下了它。 */
  evidence: string;
}

export type AgentFirstRunStateFormat = 'json' | 'toml' | 'doc';

export type AgentFirstRunStateContext = {
  cwd: string;
  homeRoot: string;
};

export interface AgentFirstRunState {
  /** Relative to the provider config root (or computed from this spawn's context). */
  relPath: string | ((ctx: AgentFirstRunStateContext) => string);
  format: AgentFirstRunStateFormat;
  /** Returns key/value entries for this spawn's workspace. */
  entries: (ctx: AgentFirstRunStateContext) => Record<string, unknown>;
  evidence: string;
}

export interface SessionBundleDescriptor {
  /**
   * 这一家把设置递给引擎走哪条路 —— **必答，没有默认值**。
   *
   * ⚠️ 按 **harness** 声明，一家一个答案，❌ 不按腿拆：按腿拆会让同一个智能体有两份
   *    互不相干的配置各自漂移；而且一家支持运行时注入，它的协议腿大概率也支持。
   *    「两条腿可以有不同的答案」说的是**怎么注入**，不是**走哪一侧**。
   *
   * ⚠️ ❌ 不许由 `configRoot` 之类别的字段推导出来。属性一旦是推导的，就没有人做过
   *    「这家该走哪一侧」这个决定 —— 想要托管侧顺带提供的某个小能力（如首启状态），
   *    就得声明成托管，于是整份复制被夹带进来（#4834 实测：一夜 70 GB）。
   */
  injectionMode: AgentInjectionMode;
  /** 平台额度怎么送进这一家(见 `HarnessPlatform`)。**必答**:没接的给 `{ kind: 'unsupported' }`。 */
  platform: HarnessPlatform;
  /** Static credential delivery/recovery capability; lease state belongs to the host runtime. */
  credentialLifecycle?: SessionCredentialLifecycleBySurface;
  /** 见 {@link AcpConfigRoot}。 */
  acpConfigRoot?: AcpConfigRoot;
  surfaces: readonly HarnessSessionSurface[];
  sessionpage: Partial<Record<SessionpageSessionSurface, SessionpageSessionIntegration>>;
  runtimeCompatibility?: Partial<Record<HarnessSessionSurface, SessionRuntimeCompatibility>>;
  units: {
    mcp: SurfaceScopedUnitDelivery<
      | 'plugin-manifest'
      | 'acp-session'
      | 'process-config'
      | 'workspace-config'
      // 咕咕**从用户当下那份系统级配置生成一份 run-scoped 隔离副本**(source-backed overlay),
      // 再用厂商自己的路径环境变量把引擎指过去。❌ 不改用户的任何配置文件,副本随 run 目录消亡。
      //
      // ⚠️ 与 `'config-file-argv'` 的分工看似重叠,分界是**密钥能不能留在环境里**:那条把整份
      //    MCP 配置当普通文件读(qwen 实测 `parseMcpConfig` 只做 readFile→JSON.parse→校验,
      //    全程无环境变量解析),于是 `Authorization` 只能以**明文**落进 run home —— 撞
      //    session-capability-contract 的「secret value 不进入 argv、静态 artifact」与
      //    「不得把认证字节复制进 run home」。本条走的是厂商的 **settings 加载器**,`${VAR}`
      //    照常展开,令牌因此只存在于子进程环境里。
      //    实测(d15,qwen 0.23.0,2026-09-03,同一份字节的 A/B):
      //      · `--mcp-config <file>` → 线上收到字面串 `${GUGU_PROBE_TOKEN}`;
      //      · `QWEN_CODE_SYSTEM_SETTINGS_PATH=<file>` → 线上收到展开后的真值;
      //      · 且与用户自己的 `~/.qwen/settings.json` **合并** —— 用户自己那台 MCP server
      //        照常被 spawn(阳性对照),不是替换。
      // ⚠️ 用它必须**同时**把厂商的 system-defaults 路径钉回平台默认值:qwen 的
      //    `getSystemDefaultsPath()` 是从 system settings 路径的**目录**推出来的,只改前者会把
      //    管理员那份 `system-defaults.json` 一起顶掉。
      | 'system-config-overlay'
      // 咕咕写进**自己那份配置根**里的配置文件(独立 home)。见下面 `'config-file'` 的说明。
      | 'config-file'
      // 咕咕把会话级 MCP 配置写成 run-scoped 文件,再用**厂商自己的会话参数**把引擎指过去
      // (终端腿专用)。与 `'user-config'` 的本质区别:❌ 不碰用户的配置文件,payload 随 run
      // 目录消亡,不需要固定名/幂等/占位符那套 writer 纪律。与 `'process-config'` 的区别
      // 镜像 promptBlocks 的 `'prompt-file-argv'`:argv 里只有一个路径指针,正文在 artifact
      // 里 —— 只声明 argv 会让读的人以为配置正文在命令行里(顺带把 Authorization 值暴露进
      // ps)。首个消费者 copilot 1.0.82 的 `--additional-mcp-config @<file>`(发行字节
      // :7403892 "augments config from ~/.copilot/mcp-config.json for this session";
      // 连接侧实测 2026-09-01:隔离 COPILOT_HOME + 假 provider 端点,-p 与交互 pty 两模式
      // 均完成 server/discover→initialize→initialized→tools/list 四连,Authorization 头
      // 逐请求在场;无 flag 阴控 0 命中)。
      | 'config-file-argv'
      // Session-scoped registration through a harness extension event; the extension owns the
      // client and receives only a runtime declaration, never a persisted MCP config.
      | 'extension-event',
      McpDeliveryExtra
    >;
    env: SurfaceScopedUnitDelivery<'child-process'>;
    model: SurfaceScopedUnitDelivery<
      | 'session-config'
      | 'process-config'
      | 'argv'
      // 咕咕把模型写进**自己那份配置根**里的配置文件(独立 home)。
      // ⚠️ 与 'process-config' 的区别不是形式而是**能力**:有些引擎的模型元数据
      // (kimi 的 `support_efforts` —— 决定思考控件长成档位还是开关)**只**在配置文件里有,
      // env/argv 根本没有对应的键。套错通道会让「声明了档位却恒是开关」静默通过。
      // ⚠️ 它**不写用户的**配置文件 —— 那是 behavior `agent-config-boundary` 的红线;
      // 落点由 `TomlOverlay` 钳在咕咕的地盘里。
      | 'config-file'
      // run-scoped 的隔离副本(source-backed)+ 厂商自己的路径环境变量。
      // ⚠️ 加进这一维的理由是**能力**,与 `'config-file'` 那条同构:
      //    环境变量/argv 只表达得了**一条**模型,而「这条会话还能换到哪几条」是一个**列表** ——
      //    只有文件写得下。qwen 的终端腿就是这样:选中的那条走三个 OpenAI 变量,
      //    整组可切模型进它自己的 `modelProviders`(与本家 MCP 同一份 settings 副本)。
      //    ⇒ 套 `'config-file'` 会说错落法(那条填 tomlOverlays/artifacts,这条填 jsonOverlays/env)。
      | 'system-config-overlay'
    >;
    autonomy: SurfaceScopedUnitDelivery<'session-mode' | 'process-config' | 'argv'>;
    promptBlocks: SurfaceScopedUnitDelivery<
      | 'system-meta'
      | 'developer-instructions'
      | 'argv-append'
      // 咕咕写一份提示档到**自己的目录**,再用启动参数把引擎指过去(终端腿专用 ——
      // 协议腿递不进启动参数)。⚠️ 与 'argv-append' 的区别是它**同时**产出 artifact:
      // 只声明 argv 会让读的人以为提示词正文在命令行里,其实命令行里只有一个路径。
      // ⚠️ 与 'session-prompt-file' 的区别是指针走 argv 不走 env —— 那条的 env
      // 「有没有提示都会设」,这条的 argv 只在真有提示时才追加,判据看得见兑现。
      | 'prompt-file-argv'
      // behavior `agent-context-injection` 的**第 ③ 块**:走用户级载体的会话级系统提示词。
      //
      // 有的 harness 就是不接受系统提示词注入,那这段话只能以**用户级提示词的身份**
      // 进到这一轮的输入里。⚠️ **这不是降级**,是那类 harness 的正常形态 —— 身份、作者、
      // 生命周期一样没变,变的只是走哪根管子,所以呈现也不变:**照样不展示给用户**。
      //
      // ⚠️ **这条通道替掉了曾经的 `first-turn-hidden-context`(2026-08-27 删除)。**
      // 那条的名字说的是 A(首轮的隐藏上下文),实现的却是 B —— `session/new` 的
      // `_meta.systemPrompt.append`,咕咕**自己的**约定、不是 ACP 协议字段,只有咕咕给 codex
      // 写的 shim 与 claude 的适配器在读;厂商原生的 ACP server 收下即丢(copilot 实测 0/6,
      // 阳性对照 6/6)。名实不符让四家在它上面挂了「已送到」却一个字没送,而判据只问
      // 「这一格填了没有」、不问「这根管子对这家通不通」,于是一路绿。
      // ⇒ 删掉它、四家改走本条。走系统位的那两家有自己的通道名
      //   (`system-meta` / `developer-instructions`),不受影响。
      // ❌ 别再造一条「名字描述意图、实现是另一回事」的通道:那正是这次要修掉的东西。
      //
      // ⚠️ 只有**这一轮的输入由咕咕组装**的腿够得着(协议腿)。终端腿不适用:那里咕咕
      // 只能替用户「打字」,打进去会原样铺在他眼前。
      | 'session-context'
      | 'process-config'
      | 'extension-event'
      // 引擎启动时从一份**咕咕写出来的文件**读系统提示（文件落在 run-scoped home，
      // 由一个 env 指过去）。⚠️ 与 'process-config' 的区别是判据能不能看见兑现：
      // 那条只看 argsAppend/env，而这类通道的 env（home 路径）**有没有提示都会设**，
      // 真正随提示变的是 artifacts。套错通道 ⇒ 「声明 native 却什么都没投递」静默通过。
      | 'session-prompt-file'
      // 引擎**每次调模型之前**跑一个钩子,钩子的输出可以往这一次调用里插一条不落进历史、
      // 不上屏的消息(Antigravity `agy`:PreInvocation 钩子回 `injectSteps:[{ephemeralMessage}]`,
      // 官方 https://antigravity.google/docs/hooks#preinvocation)。咕咕把那段输出写成一份
      // run-scoped 文件(artifacts),用一个 env 把钩子指过去(env)—— 钩子文件是两条腿共用的,
      // 会话事实只能走这次 spawn 的环境。
      // ⚠️ 与 'session-prompt-file' 的区别是**生命周期**:那条在启动时读一次、之后随会话记录走;
      //    这条每次调用都现插、从不进历史 ⇒ 续跑时也必须重新投递(宿主据此在续跑时照带身份块,
      //    见 `promptBlocksReplayedEverySpawn`)。
      | 'hook-ephemeral'
    >;
  };
  extension: ExtensionDelivery;
  /**
   * 共处能力的**子类声明** —— 只写这一家咕咕**真接通了**的那几维,其余落回
   * `BASE_SESSION_COEXISTENCE`(= 尚未接通)。读取一律经 `resolveSessionCoexistence`,
   * ❌ 别直接读这个字段,那样会把「没覆盖」误当成「没有该维度」。
   *
   * 可选是为了让各家能各自上线,不是为了可以不管:考卷按 #3889 的官方证据逐格对账,
   * 「厂商有、这里还落在基类」会被记成欠账并要求收敛。
   */
  coexistence?: Partial<SessionCoexistence>;
  /**
   * TUI 腿的中断键 —— 声明它,`coexistence.pause` 才允许 `interrupt-key`(考卷 `tui-coexistence-conformance`
   * 双向钉住:声明了键位就必须声明 pause,声明了 pause 就必须有键位)。
   *
   * 为什么落在 descriptor 而不是 behavior:它是一条**事实声明**(这一家的中断键是什么),不是
   * 一段可执行策略。宿主拿它展开成 pty 写入序列(`tuiInterruptWrites`),各家不写代码。
   *
   * ⚠️ 类型见 `SessionTuiInterrupt`:`evidence` 是必填的厂商出处 —— 键位填错的代价是**杀掉用户的会话**
   * 却在界面上报「已暂停」,所以没取证就别声明。
   */
  sessionTuiInterrupt?: SessionTuiInterrupt;
  /** 终端提问选择器能从咕咕的提问卡回答(#6798、#7035),见 `SessionTuiQuestionAnswer`。没声明的家,提问只能在终端里答。 */
  sessionTuiQuestionAnswer?: SessionTuiQuestionAnswer;
  /**
   * 这家的配置根 —— 声明了就走独立 home(见 `AgentConfigRoot`)。
   * 不声明 = 这家沿用用户的配置根,咕咕不为它另持一份。
   */
  configRoot?: AgentConfigRoot;
  /** 见 `NativeHome`。 */
  nativeHome?: NativeHome;
  /** 见 `ShellEnv`。 */
  shellEnv?: ShellEnv;
  /**
   * 这家怎么在**会话级**关掉一台 MCP server(spec `mcp-session-toggle`,`/mcp` 面板用)。
   *
   * ⚠️ **不声明 = 咕咕对这家还没有已证实的关闭通道** ⇒ 面板把这家的开关置灰并说明原因。
   * 这个默认是有意的:一个**猜**出来的方言写进 spawn,表现是「界面说关了、工具表纹丝不动」,
   * 而且不会有任何报错。宁可如实说「还没办法」,也不要一个静默失效的开关。
   *
   * 已实测三家(2026-09-06,临时 HOME + 裸 ACP,判据是探针 server 自己的
   * `initialize` / `tools/list` 账本 —— harness 自己发的,与模型想不想用无关):
   * - `config-content-enabled`:进程配置文档里逐台 `enabled: false`(与用户配置合并)
   * - `config-arg-enabled`:spawn 参数逐台 `<prefix>.<名>.enabled=false`
   * - `disallowed-tools`:harness 自己的工具黑名单逐台摘掉(claude 的 `disallowedTools`,2026-10-07 实测)
   */
  mcpToggle?: {
    dialect: 'config-content-enabled' | 'config-arg-enabled' | 'disallowed-tools';
    /** `config-arg-enabled` 专用的键前缀(如 `mcp_servers`)。❌ 不给默认值:猜错=静默失效。 */
    configArgPrefix?: string;
    /**
     * 用户在这一家上能表达到多细。缺省 `per-server`。
     *
     * `'all-or-none'` = 关掉任何一台 ⇒ 用户配置里的那一整组都不装载。
     * claude 过去是这一格,而成因**在咕咕这一侧**:接管之后能递回去的只有咕咕自己那台,
     * 因为 `SessionMcpServer` 过去只能表达 HTTP + 至多一个 Authorization 头,
     * 而用户的 server 多半是 stdio。⇒ 把那个类型拓成 `stdio | http` 之后这里就能翻成逐台。
     *
     * ⚠️ 面板必须按它换形状:整组的家只渲染**一个**开关,
     * ❌ 不许渲染 N 个 —— 那会让用户以为只关了一台,而实际另外几台也没了。
     */
    granularity?: 'per-server' | 'all-or-none';
  };
  /**
   * 这一家在咕咕起的会话里怎么关掉它**自己的**自更新(#6186,owner 2026-09-22 拍板「关掉」)。
   * 宿主经 `harnessSelfUpdateLaunch` 读它,在启动这一家的那几处统一施加;❌ 各 spawn 点按家另写。
   * 不声明 = 咕咕还没核过这一家。形状与判据见 `HarnessSelfUpdateControl`。
   */
  selfUpdate?: HarnessSelfUpdateControl;
}

/**
 * 关自更新的**会话级**通道。harness 在会话里自己更新,改的是用户自己的全局安装
 * (`~/.qwen/updates`、`~/Library/Caches/copilot/pkg`、npm/brew 全局包……),同机的会话因此跑在不同版本上。
 * 版本只由用户自己的安装或咕咕的托管安装决定。
 *
 * - `session-env`:只在这一次 spawn 的环境里说,进程退出不留一个字节。
 * - `session-argv`:同一档,载体是 argv(没有 env 开关的家,如 codex 的 `-c`)。只对终端腿成立。
 * - `upstream-blocked`:查过厂商文档、源码与二进制,没有会话级通道。
 *   ❌ 不许为了关掉它去写用户 HOME 下的全局配置 —— 那正是本条要消除的问题。
 *
 * `evidence` 必须带可复核坐标(见 `hasCitedEvidence`),写清在哪一版、哪条代码路径上实测过。
 */
/** 会话级通道的种类 —— 自更新与 hooks(#6195)共用同一套词:env、argv,或查过确实没有(上游阻塞)。 */
export type HarnessSessionChannelKind = 'session-env' | 'session-argv' | 'upstream-blocked';

export type HarnessSelfUpdateControl =
  | { kind: 'session-env'; env: Readonly<Record<string, string>>; evidence: string }
  | { kind: 'session-argv'; args: readonly string[]; evidence: string }
  | { kind: 'upstream-blocked'; evidence: string };

/** 宿主启动这一家时要带上的关自更新 env / argv —— 宿主侧的唯一读法。 */
export function harnessSelfUpdateLaunch(
  descriptor: Pick<SessionBundleDescriptor, 'selfUpdate'>
): { env: Readonly<Record<string, string>>; args: readonly string[] } {
  const control = descriptor.selfUpdate;
  if (control?.kind === 'session-env') return { env: control.env, args: [] };
  if (control?.kind === 'session-argv') return { env: {}, args: control.args };
  return { env: {}, args: [] };
}

/**
 * opencode event-module acp 的已知下界。
 *
 * 取 `1.18.0` —— 这条集成是在 opencode `1.18.x` 上做出来的，minor 边界是 semver 里唯一带
 * 含义的分界；`1.17.x` 属于另一个 minor，接口差异没证据可依。
 *
 * ⚠️ ❌ 别把下界抬到「我们碰巧测过的那一版」：那正是这条闸上一版的死法 —— 它钉死
 * `1.18.18`，理由只是当时那台机器装的是它，结果装 `1.18.16` 的人和升到 `1.18.19` 的人**一起**
 * 被拒，composer 里连模型清单都读不出来。上游两三天发一个 patch，这种下界每发一次版就作废一次。
 * 上移它的唯一判据是「某个版本实测坏了」，不是「我们换了台机器测」。
 */
const SUPPORTED_EVENT_MODULE_SESSION_ACP_RUNTIME: Extract<SessionRuntimeCompatibility, { kind: 'semver-supported-floor' }> = {
  kind: 'semver-supported-floor',
  supportedFloor: '1.18.0',
  versionArgs: ['--version'],
};

/** Return the supported runtime floor required by this structural adapter shape. */
export function requiredExactRuntimeCompatibility(
  descriptor: SessionBundleDescriptor,
  surface: HarnessSessionSurface,
): Extract<SessionRuntimeCompatibility, { kind: 'semver-supported-floor' }> | null {
  return surface === 'acp'
    && descriptor.extension.kind === 'event-module'
    && descriptor.extension.format === 'opencode'
    ? SUPPORTED_EVENT_MODULE_SESSION_ACP_RUNTIME
    : null;
}

/**
 * 插件声明的 floor 是否可接受。
 *
 * 允许 declared **高于** required —— 插件拿到「某个更高的版本以下确实坏了」的证据时，能自己
 * 上移下界，不必回头改这里的结构常量。❌ 不允许更低：那等于插件单方面放宽核心的已知下界。
 */
export function matchesRuntimeCompatibility(
  declared: SessionRuntimeCompatibility,
  required: SessionRuntimeCompatibility,
): boolean {
  if (declared.kind !== required.kind) return false;
  if (declared.runtime !== required.runtime) return false;
  if (declared.versionArgs.length !== required.versionArgs.length
    || !declared.versionArgs.every((arg, index) => arg === required.versionArgs[index])) {
    return false;
  }
  if (declared.kind === 'semver-supported-floor' && required.kind === 'semver-supported-floor') {
    return semver.valid(declared.supportedFloor) !== null
      && semver.gte(declared.supportedFloor, required.supportedFloor);
  }
  if (declared.kind === 'semver-supported-ranges' && required.kind === 'semver-supported-ranges') {
    return declared.supportedRanges.length === required.supportedRanges.length
      && declared.supportedRanges.every((range, index) => range === required.supportedRanges[index]);
  }
  return false;
}

export type SessionMcpServer =
  | {
      name: string;
      /** Omitted on legacy HTTP declarations; stdio is always explicitly discriminated. */
      transport?: 'http';
      url: string;
      /** Environment variable name only; the credential value stays in the child-process env. */
      authorizationEnv?: string;
      alwaysLoad?: boolean;
      owner?: McpServerOwner;
      /** 资源库 → MCP 勾上的那台(用户自己的 server,经咕咕送):Claude 把它放进单独一个插件,❌ 混进咕咕品牌的那个。 */
      library?: true;
    }
  | {
      name: string;
      transport: 'stdio';
      command: string;
      args?: readonly string[];
      /** Map of MCP env names to references in the child-process environment, never raw values. */
      env?: Readonly<Record<string, string>>;
      cwd?: string;
      alwaysLoad?: boolean;
      owner?: McpServerOwner;
      /** 资源库 → MCP 勾上的那台(用户自己的 server,经咕咕送):Claude 把它放进单独一个插件,❌ 混进咕咕品牌的那个。 */
      library?: true;
    };

export const MODEL_CONFIG_DIALECTS = [
  'codex-config-flags',
  'provider-env',
  'pi-models-json',
  'opencode-config-content',
  'qwen-openai-env',
  'hermes-serve-env',
  'grok-xai-env',
  'gemini-env',
  'kimi-model-env',
  'qoder-byok-settings',
  'mimocode-config-content',
  'copilot-provider-env',
  'zcode-provider-table',
  'codebuddy-settings-env',
] as const;

export type ModelConfigDialect = (typeof MODEL_CONFIG_DIALECTS)[number];

export const MODEL_CONFIG_DIALECT = { requiresContextWindow: new Set<ModelConfigDialect>(['opencode-config-content', 'mimocode-config-content']) };

/**
 * 签发响应的 `callable_routes`(#6921):网关路由原文(`/v1/images/generations`)→ 这枚会话令牌在那条路由上能调的模型。
 * 只给 harness 判断要不要打开对应的内置工具(codex 出图),❌ 不进模型选择器。
 */
export type PlatformCallableRoutes = Readonly<Record<string, readonly string[]>>;

export interface SessionModelCapability {
  dialect: ModelConfigDialect
  model?: string
  reasoningEffort?: string
  serviceTier?: string
  /**
   * The platform relay this session was issued, when it is running on Gugu quota.
   *
   * Only set for platform sessions. Harnesses that cannot be redirected by a bare
   * base-URL/key pair (opencode reads a config document, not provider env vars) need
   * the endpoint and the session token together with the model id, because for them
   * "which model" and "whose endpoint" are one declaration rather than two.
   *
   * Deliberately passed in rather than read back out of the spawn environment: on a
   * BYOK or default session that environment may legitimately carry the user's own
   * OPENAI_API_KEY, and treating that as a platform token would bill the wrong party
   * and leak a user key into a Gugu-authored provider block.
   */
  platformProvider?: { baseUrl: string; apiKey: string }
  /**
   * Every Gugu model this session may run on, for harnesses whose own model picker we
   * populate.
   *
   * A platform session points the whole process at Gugu's relay, so any model the harness
   * offers that we do not serve would be rejected on use. Listing ours — and only ours — in
   * the picker is what keeps the harness's own switcher from becoming a trap. It is a set,
   * not one id, because the user is entitled to switch among them; `model` remains the one
   * the session starts on.
   */
  platformModels?: readonly {
    id: string
    displayName: string
    contextWindow?: number | null
    reasoningEfforts?: readonly string[] | null
  }[]
  /**
   * The reasoning levels this platform model accepts (`billing.platform_models.reasoning_efforts`, #6447).
   *
   * Per model, like the window: the gateway passes `reasoning.effort` / `output_config` through and each
   * upstream validates its own set (glm-5.3 low/high/max, claude-opus-5 up to max). Codex's catalog
   * declares it for models codex has no metadata for. Null/absent = the directory has none.
   */
  reasoningEfforts?: readonly string[] | null
  /**
   * The platform model's real context window, in tokens (`billing.platform_models.context_window`).
   *
   * A harness sizes its own compaction against whatever window it believes the model has, and a
   * gateway alias is never an id it recognizes — so left alone every one of them falls back to a
   * conservative default and compacts (or hard-errors) far below the real limit. Gugu owns the
   * true value, so Gugu states it.
   *
   * Carried on the capability rather than folded into `platformSettingsEnv` because only Claude
   * Code takes it as an environment variable; codex takes a config flag and opencode a field
   * inside its config document. Each harness emits it in its own shape (see each plugin's `platform-model.ts`).
   *
   * Null/absent = unknown. Dialects that can keep their own conservative default may omit it;
   * OpenCode-family config documents omit the field during generic materialization, while the
   * platform launch path rejects an unknown window before spawning (their provider schema requires
   * `limit.context`).
   * ❌ Never substitute a guess: too large turns "compacts early" into "overflows the gateway",
   * which is the worse failure.
   */
  contextWindow?: number | null
  /**
   * The provider environment this platform session must run on, in the shape the harness's own
   * **settings file** takes — for harnesses whose settings file out-ranks the process environment.
   *
   * Claude Code is one: an `env` block in `~/.claude/settings.json` is written into the process
   * environment at startup and therefore beats anything we exported before spawning (documented
   * on code.claude.com's env-vars page; caught on a real machine, where a user's own
   * `ANTHROPIC_BASE_URL` silently took a platform-billed session to their own gateway). Carrying
   * the values here lets the loader put them somewhere that outranks that file.
   *
   * Anthropic-shaped on purpose: `platformProvider.baseUrl` carries the `/v1` suffix the two
   * OpenAI-surface dialects need, which is exactly wrong for `ANTHROPIC_BASE_URL`.
   */
  platformSettingsEnv?: Readonly<Record<string, string>>
  /**
   * The issue response's `callable_routes` (#6921): gateway route, verbatim → the models this session
   * token may call there. Only for a harness deciding whether to turn on one of its own built-in tools
   * (codex image generation); never a picker input. Absent = an older server = none.
   */
  platformCallableRoutes?: PlatformCallableRoutes
}

export interface SessionAutonomyCapability {
  mode: 'approval-required' | 'full-access';
  /**
   * Exact product tier, authoritative when present. `mode` is the legacy coarse channel derived from
   * this value; old boolean-only callers omit it and retain their historical behavior.
   */
  permissionMode?: GuguPermissionMode;
}

export interface SessionPromptBlocks {
  platform?: string;
  identity?: string;
  threadBootstrap?: string;
}

export interface GeneratedArtifact {
  path: string;
  content: string;
  mode: 0o600 | 0o644;
  target?: 'gugu-home' | 'workspace';
}

/**
 * 一个 Gugu 历史上写下、现在要**回收**的工件。apply 层按**逐字节**匹配删除:盘上内容与
 * `content` 深等才删,不等就原样留着(那是用户自己的文件,不是我们的残留),只认自己那份字节。
 * `path` 绝对路径,`target` 决定钳在哪个根下(默认 workspace)。
 */
export interface RetiredArtifact {
  path: string;
  content: string;
  target?: 'gugu-home' | 'workspace';
}

export interface TomlOverlay {
  sourcePath: string;
  path: string;
  patch: Record<string, unknown>;
  /**
   * 补丁与已有值撞了怎么办。
   *
   *  · `'fail'` —— 撞了就抛。用于「读**用户的**文件、写**咕咕的**文件」:那种场景下撞车
   *    意味着咕咕要改写用户的意图,必须响亮地停下。
   *  · `'gugu-owns'` —— **补丁赢**。只用于「读写**咕咕自己那份**配置根」(独立 home):
   *    这些键从头到尾就是咕咕写的,第二次会话把它们改成新值是**正常**的,不是冲突。
   *    ⚠️ 用它的前提是 `sourcePath` 与 `path` 都在咕咕的地盘里 —— 拿它去写用户的文件
   *    就是「静默改用户配置」,正是 `'fail'` 存在的理由。
   */
  conflict: 'fail' | 'gugu-owns';
  mode: 0o600;
}

/**
 * `TomlOverlay` 的 JSON 同形 —— 同一个 source-backed 模式:读**用户当下**那份配置,合并咕咕这一
 * 次会话的补丁,写进**咕咕自己的地盘**,原文件一个字节不动。
 *
 * ⚠️ 存在的理由是 spec 那句「source-backed overlay 每次从用户当前配置生成隔离目标,保留用户
 *    原生配置而不改写原文件」：把引擎的**系统级**配置整份重定向到咕咕的副本时,如果不先把用户
 *    (管理员)那份读进来,就等于在这次会话里静默吞掉了他的策略 —— 那是 fail-open,不是隔离。
 * ⚠️ `conflict` 语义与 `TomlOverlay` 逐字一致:读用户文件、写咕咕文件的场景一律 `'fail'`,
 *    撞了就响亮地停 —— 同名键意味着咕咕要改写用户的意图。
 */
export interface JsonOverlay {
  sourcePath: string;
  path: string;
  patch: Record<string, unknown>;
  conflict: 'fail' | 'gugu-owns';
  /**
   * 这几个顶层键之下,数组按厂商自己的合并语义**拼接**(源在前、补丁在后),不算冲突。
   * 只给厂商明确声明为 concat 的键用(qwen 的 `hooks.<Event>`:settingsSchema 里 mergeStrategy=concat)——
   * 管理员自己的同名事件 hooks 与咕咕的并存,❌ 不因为「同一个事件也有人装了 hook」就拒绝起会话。
   */
  concatArraysUnder?: readonly string[];
  mode: 0o600;
}

export interface GeneratedSymlink {
  sourcePath: string;
  path: string;
  optionalSource: boolean;
  /**
   * 源目录缺失时创建它,而不是跳过。用于「必须落在用户真实 home 的持久化存储」:run-scoped home 是
   * 一次性的,跳过软链就等于把该存储写进用完即弃的目录 —— 数据当场看着正常,下一次 run 才发现没了。
   * 与 optionalSource 互斥(同时为真 = 声明自相矛盾,物化时 fail loud)。
   */
  ensureSourceDirectory?: boolean;
}

export interface DirectorySymlinkOverlay {
  sourcePath: string;
  path: string;
  optionalSource: boolean;
  conflict: 'fail';
  /**
   * 只接源目录里以这些后缀结尾的**顶层文件**;省略 = 接全部条目(既有行为)。
   *
   * 用于「源目录里只有一部分是跨-run 用户数据」的情形:overlay 的落点常常就是 run-scoped home
   * 自己,把整个用户 home 接过来会和本次 run 要写的配置撞车。按后缀而不是按文件名,是因为
   * 承载状态的文件名往往带 schema 版本号(`state_5.sqlite`);写死文件名的话,上游一升版就**静默**
   * 退回「每次 run 重建一次状态」——没有任何判据会红,只有用户会变慢。
   */
  includeSuffixes?: readonly string[];
}

/**
 * #6387 An Agent Skill an installed extension brings (`<dir>/SKILL.md`). Adapters whose
 * per-session plugin folder carries skills natively mount `dir` there; every other session
 * gets it through the catalog in the platform block (name, description, where SKILL.md is).
 */
export interface ExtensionSkill {
  extensionId: string;
  name: string;
  description: string;
  dir: string;
}

/**
 * Whether this harness mounts extension skills itself — a per-session plugin folder that carries
 * skills (claude), or skill roots its engine registers (codex). The rest get the catalog in the
 * platform block instead — never both, so no agent sees the same skill twice.
 */
export function mountsExtensionSkillsNatively(extension: ExtensionDelivery | undefined): boolean {
  return (
    extension?.kind === 'declarative-bundle' &&
    (extension.activation === 'session-dir' || extension.activation === 'skill-roots') &&
    extension.carries.skills === 'manifest'
  );
}

/** Folder name a skill is mounted under: prefixed so two extensions' `notes` never collide. */
export function extensionSkillFolderName(skill: ExtensionSkill): string {
  const folder = skill.dir.split(/[\\/]/).filter(Boolean).pop() ?? skill.name;
  return `${skill.extensionId}-${folder}`;
}

export interface CapabilityPackage {
  id: string;
  version: string;
  artifacts: readonly GeneratedArtifact[];
}

export interface SessionCapabilityBundle {
  /** Stable product conversation/session key for adapters that need per-session owned state. */
  sessionKey?: string;
  mcpServers: readonly SessionMcpServer[];
  /**
   * 用户在 `/mcp` 里为这条会话**关掉**的那几台 server(harness 自己的配置键)。
   *
   * ⚠️ 它与上面的 `mcpServers` **不是一回事,别合并**:
   * `mcpServers` 是**咕咕自己注入**的那些(它们本来就不在用户配置里);
   * 这一格说的是**用户自己配置里的**那些里,哪几台这一次不要装载。
   * 两者载体不同 —— 前者经 `session/new` 递过去,后者只能在 spawn 配置里说
   * (各家方言见 spec `mcp-session-toggle`)。
   *
   * ⚠️ `[]` 与缺席**不同**:`[]` = 用户决定过、一台没关;缺席 = 从没碰过。
   * 各家物化器按 `mcpToggleDirective` 处理,一台都没关时它返回 `none`,不发任何指令。
   */
  mcpDisabled?: readonly string[];
  /** #6387 Skills installed extensions bring to this session. */
  extensionSkills?: readonly ExtensionSkill[];
  env: Readonly<Record<string, string | undefined>>;
  model: SessionModelCapability | null;
  autonomy: SessionAutonomyCapability | null;
  promptBlocks: SessionPromptBlocks;
  packages: readonly CapabilityPackage[];
}

/**
 * Materializers are synchronous pure functions: they turn one declaration into values, paths and
 * patches. Every filesystem read/write — including resolving the sources they name — belongs to
 * the apply layer, which is why the context carries no filesystem handle.
 */
export interface ISessionBundleBehavior {
  /** Exact host implementation for transport-owned session-TUI lifecycles; absent means direct materialization. */
  sessionTuiHostAdapter?: Exclude<SessionTuiHostAdapter, 'provider-session-bundle'>;
  /** 平台模型的写法(见 `IPlatformModelBehavior`)。`platform` 声明为 supported 的家必须有,注册时核。 */
  platformModel?: IPlatformModelBehavior;
  materialize(
    ctx: {
      surface: HarnessSessionSurface;
      lifecycle: 'fresh' | 'fork' | 'resume';
      cwd: string;
      /**
       * 这一次 spawn 的 argv **会不会自己带续跑 flag**。
       *
       * ⚠️ 与 `lifecycle` **不是**一回事，别拿 `lifecycle === 'resume'` 代替它。
       * `lifecycle` 由 `resumeProviderSessionId` 推出，而 argv 的续跑分支看的是
       * `isResuming`（`buildStandardCommand`）。两者在**「要续跑、但引擎自己的 session id
       * 还没拿到」**那一格上分叉：`resolveAgentSessionCommandArgs` 只对
       * 声明了 `sessions.resumeNeedsProviderId` 的家把 `isResuming` 压成 false，
       * 没声明的家原样透传 ⇒ `lifecycle === 'fresh'` 而 argv 里已经有 `-C` 了。
       *
       * 谁需要它：往 argv 上追加**与续跑 flag 互斥**的参数的家。套错会「平时零发作、
       * 只在极端路径显形」——那一发不是降级，是**引擎拒绝启动**。
       */
      isResuming?: boolean;
    },
    bundle: SessionCapabilityBundle
  ): SessionMaterialization;
}

export type SessionMaterializationContext = Parameters<ISessionBundleBehavior['materialize']>[0];

export type CapabilityUnit = 'mcp' | 'env' | 'model' | 'autonomy' | 'promptBlocks' | 'packages';

export interface SessionMaterialization {
  argsAppend: readonly string[];
  env: Readonly<Record<string, string>>;
  /** Native per-thread config overrides for app-server style session-open calls. */
  threadConfig?: Readonly<Record<string, unknown>>;
  /** Native fields for the provider's thread/start call, kept out of process argv. */
  threadStart?: Readonly<Record<string, unknown>>;
  /**
   * #6387 Skill folders the engine registers at runtime as extra skill roots (activation `'skill-roots'`):
   * each holds `<skill>/SKILL.md` entries, made by this materialization's `symlinks`.
   */
  skillRoots?: readonly string[];
  /** Provider-native fields for an HTTP/session create request (for example OpenCode's agent mode). */
  sessionCreatePatch?: Readonly<{ agent?: string }>;
  acp?: { mcpServers: readonly McpServer[]; meta?: Record<string, unknown> };
  prompt?: {
    value: string;
    delivered: readonly (keyof SessionPromptBlocks)[];
    /**
     * 这段话走哪根管子进 agent —— behavior `agent-context-injection` 的 ② 与 ③。
     *
     * - `'system'`(缺省)= ②:走**系统位**。宿主落成 `session/new` 的
     *   `_meta.systemPrompt.append`,再由各家适配层映射到自己的系统位
     *   (codex 的 `developerInstructions`、claude 的 `systemPrompt.append`)。
     * - `'session-context'` = ③:没有系统位可坐,以**用户级载体**进到首轮的输入里。
     *
     * ⚠️ **必须显式区分,❌ 不许合成一个字段。** 两者的判据正相反:② 要求这段话
     * **不得**出现在任何一次发往 provider 的 prompt 里(`@@@system-prompt-channel`),
     * ③ 要求它**必须**在首轮的 prompt 里。合成一个 ⇒ 两边的判据互相把对方变成平凡真。
     *
     * ⚠️ 缺省是 `'system'`:既有的家一个字都不用改,而新写的家要走 ③ 必须**显式写出来** ——
     * 让「我走的是用户级载体」成为一句说出口的话,而不是一个默认值。
     */
    carrier?: 'system' | 'session-context';
  };
  configMerges: readonly JsonMerge[];
  artifacts: readonly GeneratedArtifact[];
  /**
   * Gugu-owned workspace/home artifacts the host must retire before spawn, matched **byte-exact**:
   * the apply layer deletes a file only when its bytes deep-equal `content`, and leaves anything
   * else (a genuinely user-owned file at the same path) untouched. Used by #4895 to reclaim the
   * OpenCode notification plugin residue from workspaces polluted by the old implementation without
   * ever deleting a user's own file.
   */
  retiredArtifacts?: readonly RetiredArtifact[];
  tomlOverlays?: readonly TomlOverlay[];
  jsonOverlays?: readonly JsonOverlay[];
  symlinks?: readonly GeneratedSymlink[];
  directorySymlinkOverlays?: readonly DirectorySymlinkOverlay[];
  report: {
    adapterId: string;
    surface: HarnessSessionSurface;
    units: Record<
      CapabilityUnit,
      { status: 'loaded' } | { status: 'degraded'; reason: Degradation }
    >;
    discoveredCommands: readonly string[];
  };
}

// ⚠️ 先把 `per-surface` 那一支剥掉再取 channel：直接对 `SurfaceScopedUnitDelivery` 做
//    `infer` 会因为多了一支不带 `channel` 的成员而推不出来（静默塌成 never，
//    于是 `SessionBundleNativeChannel` 变空、物化字段表的 satisfies 反而全绿）。
type DeliveryChannel<T> = Extract<T, { kind: 'native'; channel: string }> extends {
  channel: infer Channel;
}
  ? Channel
  : never;

export type SessionBundleNativeChannel = DeliveryChannel<
  SessionBundleDescriptor['units'][keyof SessionBundleDescriptor['units']]
>;

export type SessionMaterializationField =
  | 'argsAppend'
  | 'env'
  | 'threadConfig'
  | 'threadStart'
  | 'acp'
  | 'prompt'
  | 'configMerges'
  | 'artifacts'
  | 'tomlOverlays'
  | 'jsonOverlays';

/** The contract-level source of truth for which materialization fields each native channel fills. */
export const SESSION_BUNDLE_CHANNEL_MATERIALIZATION_FIELDS = {
  'plugin-manifest': ['artifacts', 'env', 'tomlOverlays'],
  'acp-session': ['acp'],
  'process-config': ['argsAppend', 'env', 'threadConfig', 'threadStart'],
  // 咕咕在**自己那份配置根**里写的配置文件。三种落法都算:TOML 走 overlay(要与已有内容合并),
  // JSON 整份重写走 artifact,JSON 要与已有内容 key 级合并时走 jsonOverlay(`conflict: 'gugu-owns'`,
  // 源与目标同一份托管文件 —— Antigravity 终端腿的 `mcp_config.json`:那份是从用户 `~/.gemini` 带过来的,
  // 里面有用户自己的 server,整份重写会把它们抹掉)。⚠️ 它**不写用户的**文件 —— 落点由 overlay /
  // artifact 钳在咕咕的地盘里(`within(guguHome, …)`),那是 behavior `agent-config-boundary` 的红线。
  'config-file': ['tomlOverlays', 'artifacts', 'jsonOverlays'],
  // run-scoped 配置文件 + argv 路径指针(mcp 单元的 'prompt-file-argv' 对应物,见 union 注释)。
  'config-file-argv': ['artifacts', 'argsAppend'],
  'workspace-config': ['configMerges', 'artifacts'],
  // run-scoped 隔离副本(source-backed)+ 厂商自己的路径环境变量。两格缺一不可:
  // 只产 overlay 不设 env = 写了一份没人读的文件;只设 env 不产 overlay = 把引擎指向不存在的路径。
  'system-config-overlay': ['jsonOverlays', 'env'],
  'child-process': ['env'],
  'session-config': ['env', 'acp'],
  argv: ['argsAppend'],
  'session-mode': ['acp'],
  'system-meta': ['acp'],
  'developer-instructions': ['prompt'],
  'argv-append': ['argsAppend'],
  'prompt-file-argv': ['artifacts', 'argsAppend'],
  'session-context': ['prompt'],
  'extension-event': ['env'],
  'session-prompt-file': ['artifacts', 'env'],
  'hook-ephemeral': ['artifacts', 'env'],
} as const satisfies Record<SessionBundleNativeChannel, readonly SessionMaterializationField[]>;

export type JsonMerge = {
  kind: 'json-merge';
  path: string;
  patch: Record<string, unknown>;
  conflict: 'fail';
  mode: 0o600;
};

const degradationSchema = z.object({
  code: z.enum(['unsupported-channel', 'violates-zero-residue', 'upstream-broken', 'unverified']),
  reason: z.string().min(1),
});

const deliverySchema = <const C extends readonly [string, ...string[]], X extends z.ZodRawShape = {}>(
  channels: C,
  extra: X = {} as X
) =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('native'), channel: z.enum(channels), ...extra }),
    z.object({ kind: z.literal('none'), degraded: degradationSchema }),
  ]);

/**
 * ⚠️ `per-surface` 这一支**必须**在 schema 里,不能只有 TS 类型 —— 与下面 `coexistence`
 * 那条同一个坑:`framework.ts` 存的是 `parsed.data`,schema 里少一支,按腿写的声明会在
 * 运行时**静默塌成解析失败或字段消失**,而 tsc 与源码都看着好好的。
 *
 * ⚠️ 只给 `units` 用,`coexistence` 仍用上面那个单值的 `deliverySchema`。
 */
const surfaceScopedDeliverySchema = <const C extends readonly [string, ...string[]], X extends z.ZodRawShape = {}>(
  channels: C,
  extra: X = {} as X
) =>
  z.union([
    deliverySchema(channels, extra),
    z.object({
      kind: z.literal('per-surface'),
      surfaces: z
        .object({
          'acp': deliverySchema(channels, extra).optional(),
          'tui': deliverySchema(channels, extra).optional(),
          'app-server': deliverySchema(channels, extra).optional(),
        })
        .strict(),
    }),
  ]);

const extensionDeliverySchema = z.union([
  z.object({
    kind: z.literal('declarative-bundle'),
    format: z.enum(['claude', 'codex']),
    activation: z.enum(['session-dir', 'isolated-home', 'skill-roots']),
    carries: z.object({
      mcp: z.enum(['manifest', 'none']),
      skills: z.literal('manifest'),
      hooks: z.enum(['manifest', 'none']),
    }),
  }),
  z.object({
    kind: z.literal('event-module'),
    format: z.literal('opencode'),
    scope: z.literal('workspace'),
    carries: z.object({
      mcp: z.literal('none'),
      skills: z.literal('none'),
      systemPrompt: z.literal('none'),
      hooks: z.literal('module'),
    }),
  }),
  z.object({
    kind: z.literal('event-module'),
    format: z.literal('pi'),
    scope: z.literal('workspace'),
    carries: z.object({
      mcp: z.literal('none'),
      skills: z.literal('none'),
      systemPrompt: z.literal('module'),
      hooks: z.literal('module'),
    }),
  }),
  z.object({ kind: z.literal('none'), degraded: degradationSchema }),
]);

/** 提问回答的 schema:取消键非空(空串写进 pty 是无声的 no-op),节拍两个数为正,evidence 规则同中断键。 */
const sessionTuiQuestionAnswerSchema = z.object({
  cancel: z.string().min(1),
  settleMs: z.number().int().positive(),
  maxWaitMs: z.number().int().positive(),
  evidence: z.string().min(1),
}).strict().superRefine((answer, ctx) => {
  if (!hasCitedEvidence(answer.evidence)) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence'],
      message: 'tui question answer evidence must cite a checkable source: a URL, or owner/repo@<sha>.',
    });
  }
});

/**
 * 中断键的 schema。三条约束都对应一个真会发生的坏声明:
 * - `sequence` 非空:空串写进 pty 是无声的 no-op,界面照报「已暂停」。
 * - `presses >= 1`:0 次 = 声明了却什么都不发。
 * - `presses > 1` 必须带 `intervalMs`:连着写两个字节多半被引擎当成一次按键,双击语义失效。
 * - `evidence` 带可复核坐标:见 `hasCitedEvidence` —— 非空挡不住「实测」这类无从复核的话。
 */
const sessionTuiInterruptSchema = z.object({
  sequence: z.string().min(1),
  presses: z.number().int().min(1).optional(),
  intervalMs: z.number().int().positive().optional(),
  evidence: z.string().min(1),
}).strict().superRefine((interrupt, ctx) => {
  if (!hasCitedEvidence(interrupt.evidence)) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence'],
      message:
        'tui interrupt evidence must cite a checkable source: a URL, or owner/repo@<sha>. '
        + 'Prose such as "实测" is not a citation.',
    });
  }
  if ((interrupt.presses ?? 1) > 1 && interrupt.intervalMs === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['intervalMs'],
      message: 'tui interrupt with presses > 1 must declare intervalMs',
    });
  }
});

/**
 * ⚠️ `envVar` 与 `userPath` 都不许为空:两者缺一,独立 home 要么算不出路径、
 * 要么递不进子进程,而两种失败都是**静默**的(会话照常起,只是读了错的那份配置)。
 */
const agentConfigRootSchema = z
  .object({
    envVar: z.string().min(1),
    injectEnv: z.boolean().optional(),
    // ⚠️ 必须是 **home 相对**:绝对路径会让影子 home 那一层失效(`join` 直接跳到根),
    //    `..` 会让复制的目标落到影子 home 外面 —— 两种都是往用户机器上乱写。
    userPath: z
      .string()
      .min(1)
      .refine(
        (path) =>
          !path.startsWith('/') &&
          !/^[A-Za-z]:/.test(path) &&
          !path.split(/[/\\]/).includes('..'),
        { message: 'configRoot.userPath 必须是 home 相对路径,❌ 绝对路径、❌ `..`' }
      ),
    evidence: z.string().min(1),
    // ⚠️ **必答,但允许为空**:空数组 = 「这一家的配置根里没有派生物,全都要带」,
    //    那是个合法答案;而字段缺省 = 没人看过这一家的配置根里有什么。
    //    ❌ 别再给它 `.min(1)`:那会逼着为了满足 schema 去编一条排除项。
    carryExclusions: z.array(
      z
        .object({
          // 与 userPath / seedFiles 同一把尺子:逃出配置根就是在描述别人机器上的东西。
          path: z
            .string()
            .min(1)
            .refine(
              (path) =>
                !path.startsWith('/') &&
                !/^[A-Za-z]:/.test(path) &&
                !path.split(/[/\\]/).includes('..'),
              { message: 'configRoot.carryExclusions[].path 必须相对配置根,❌ 绝对路径、❌ `..`' }
            ),
          evidence: z.string().min(1),
        })
        .strict()
    ),
    seedFiles: z
      .array(
        z
          .object({
            // 与 userPath 同一把尺子:种子文件也是往磁盘上写,逃出配置根就是往用户机器上乱写。
            path: z
              .string()
              .min(1)
              .refine(
                (path) =>
                  !path.startsWith('/') &&
                  !/^[A-Za-z]:/.test(path) &&
                  !path.split(/[/\\]/).includes('..'),
                { message: 'configRoot.seedFiles[].path 必须相对配置根,❌ 绝对路径、❌ `..`' }
              ),
            content: z.string(),
            evidence: z.string().min(1),
          })
          .strict()
      )
      .optional(),
    firstRunState: z
      .array(
        z
          .object({
        relPath: z.union([z.string().min(1), z.custom<AgentFirstRunState['relPath']>((value) => typeof value === 'function')]),
            format: z.enum(['json', 'toml', 'doc']),
            entries: z.custom<AgentFirstRunState['entries']>((value) => typeof value === 'function'),
            evidence: z.string().min(1),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

/**
 * ⚠️ 与 `coexistence`/`sessionTuiInterrupt` 同一个坑:schema 里少这一支,
 * 声明会在运行时被 zod **静默 strip**(framework.ts 存 `parsed.data`)——源码写着、tsc 绿、
 * 读出来恒 undefined,内核于是永远按 idle-only 兜底,一条判据都不会红。
 */
const sessionpageInjectionDeclarationSchema = z.object({
  timing: z.enum(['next-tool-call', 'idle-only']),
  evidence: z.string().min(1),
  deviations: z.string().min(1).optional(),
}).strict().superRefine((declaration, ctx) => {
  if (!hasCitedEvidence(declaration.evidence)) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence'],
      message:
        'sessionpage injection timing evidence must cite a checkable source: a URL, or owner/repo@<sha>. '
        + 'Prose such as "实测" is not a citation; an undeclared slot already defaults to idle-only.',
    });
  }
});

/** 带可复核坐标的出处串(见 `hasCitedEvidence`);声明会话级通道的各格共用。 */
export const citedEvidenceSchema = (label: string) =>
  z.string().min(1).refine(hasCitedEvidence, {
    message: `${label} evidence must cite a checkable source: a URL, or owner/repo@<sha>.`,
  });

const harnessSelfUpdateControlSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session-env'),
    env: z.record(z.string().min(1), z.string()).refine((env) => Object.keys(env).length > 0, {
      message: 'session-env self-update control must name at least one variable',
    }),
    evidence: citedEvidenceSchema('self-update'),
  }).strict(),
  z.object({
    kind: z.literal('session-argv'),
    args: z.array(z.string().min(1)).min(1),
    evidence: citedEvidenceSchema('self-update'),
  }).strict(),
  z.object({
    kind: z.literal('upstream-blocked'),
    evidence: citedEvidenceSchema('self-update'),
  }).strict(),
]);

const sessionpageTerminalInputDeclarationSchema = z.object({
  submitSeparationMs: z.number().int().positive(),
  evidence: z.string().min(1),
  measurement: z.string().min(1),
}).strict().superRefine((declaration, ctx) => {
  if (!hasCitedEvidence(declaration.evidence)) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence'],
      message:
        'sessionpage terminal input evidence must cite a checkable source: a URL, or owner/repo@<sha>. '
        + 'An undeclared slot already means "no separation needed", so an uncited one buys nothing.',
    });
  }
});

const sessionpagePromptInputDeclarationSchema = z.object({
  multiline: z.enum(['bracketed-paste', 'plain']),
  evidence: z.string().min(1),
}).strict().superRefine((declaration, ctx) => {
  if (!hasCitedEvidence(declaration.evidence)) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence'],
      message: 'sessionpage prompt input evidence must cite a checkable source',
    });
  }
});

const sessionpageSessionIntegrationSchema = z.object({
  identity: z.enum(['addressable', 'none']),
  messageTransport: z.enum(['router', 'local-session', 'none']),
  inbound: z.enum(['deliverable', 'none']).optional(),
  terminalInput: sessionpageTerminalInputDeclarationSchema.optional(),
  promptInput: sessionpagePromptInputDeclarationSchema.optional(),
  hostAdapter: z.enum([
    'claude-rendezvous-v1',
    'codex-app-server-v1',
    'kimi-web-rest-v1',
    'droid-daemon-v1',
    'opencode-serve-attach-v1',
  ]).optional(),
  injection: sessionpageInjectionDeclarationSchema.optional(),
  reason: z.string().min(1).optional(),
});

const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const semverRangeSchema = z.string().min(1).refine((value) => semver.validRange(value) !== null, {
  message: 'Runtime compatibility ranges must be valid semver ranges',
});
const sessionRuntimeCompatibilitySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('semver-supported-floor'),
    supportedFloor: semverSchema,
    versionArgs: z.array(z.string().min(1)).min(1),
    runtime: z.enum(['harness', 'node']).optional(),
  }).strict(),
  z.object({
    kind: z.literal('semver-supported-ranges'),
    supportedRanges: z.array(semverRangeSchema).min(1),
    versionArgs: z.array(z.string().min(1)).min(1),
    runtime: z.enum(['harness', 'node']).optional(),
  }).strict(),
]);

const sessionCredentialLifecycleSchema = z.object({
  delivery: z.enum([
    'child-process-env',
    'process-config',
    'child-process-env+process-config',
    'credential-helper',
    'credential-proxy',
  ]),
  originalProcessRefresh: z.enum(['supported', 'unsupported']),
  recovery: z.enum(['reopen', 'none']),
  inferenceOwner: z.enum(['provider-process', 'app-server-process-thread', 'serve-process-descendants']),
  reopenEntry: z.literal('host-session-reload'),
  sourceChangeSession: z.enum(['preserve', 'replace']),
}).strict();

const platformSurfaceInjectionSchema = z.object({
  credentialSinks: z.array(z.object({
    process: z.enum(['visibleClient', 'detachedInference', 'acpAdapter']),
    carrier: z.enum(['processEnv', 'settingsDocumentFile', 'providerConfigArgs', 'spawnEnvConfigDocument', 'acpSessionMeta']),
  }).strict()),
  tokenLifetime: z.enum(['visibleClient', 'detachedInference', 'acpSession', 'acpAdapterProcess']),
  tokenReuseProbe: z.enum(['none', 'liveInferenceProcess', 'heldRecord']),
  modelSlots: z.array(z.enum(['main', 'backgroundUtility'])),
  wired: z.boolean(),
}).strict();

const harnessPlatformSchema: z.ZodType<HarnessPlatform> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('supported'),
    wireProtocol: z.enum(['anthropic-messages', 'openai-responses', 'openai-chat-completions', 'gemini-generate-content']),
    dialect: z.enum(MODEL_CONFIG_DIALECTS),
    injection: z.object({ tui: platformSurfaceInjectionSchema.optional(), cui: platformSurfaceInjectionSchema.optional() }).strict(),
  }).strict(),
  z.object({ kind: z.literal('unsupported'), reason: z.string().min(1) }).strict(),
]);

const sessionBundleDescriptorSchema: z.ZodType<SessionBundleDescriptor> = z.object({
  credentialLifecycle: z.object({
    'acp': sessionCredentialLifecycleSchema.optional(),
    'tui': sessionCredentialLifecycleSchema.optional(),
    'app-server': sessionCredentialLifecycleSchema.optional(),
  }).strict().optional(),
  acpConfigRoot: z.object({
    envVar: z.string().min(1),
    guguHomePath: z.array(z.string().min(1)).min(1),
  }).strict().optional(),
  surfaces: z
    .array(z.enum(['acp', 'tui', 'app-server']))
    .superRefine((surfaces, ctx) => {
      if (new Set(surfaces).size !== surfaces.length) {
        ctx.addIssue({ code: 'custom', message: 'Session bundle surfaces must be unique' });
      }
    }),
  sessionpage: z.object({
    'acp': sessionpageSessionIntegrationSchema.optional(),
    'tui': sessionpageSessionIntegrationSchema.optional(),
  }),
  runtimeCompatibility: z.object({
    'acp': sessionRuntimeCompatibilitySchema.optional(),
    'tui': sessionRuntimeCompatibilitySchema.optional(),
    'app-server': sessionRuntimeCompatibilitySchema.optional(),
  }).strict().optional(),
  units: z.object({
    mcp: surfaceScopedDeliverySchema([
      'plugin-manifest',
      'acp-session',
      'process-config',
      'workspace-config',
      'system-config-overlay',
      'config-file',
      'config-file-argv',
      'extension-event',
    ], { transports: z.array(z.enum(['stdio', 'http'])).optional() }),
    env: surfaceScopedDeliverySchema(['child-process']),
    model: surfaceScopedDeliverySchema([
      'session-config',
      'process-config',
      'argv',
      'config-file',
      'system-config-overlay',
    ]),
    autonomy: surfaceScopedDeliverySchema(['session-mode', 'process-config', 'argv']),
    promptBlocks: surfaceScopedDeliverySchema([
      'system-meta',
      'developer-instructions',
      'argv-append',
      'prompt-file-argv',
      'session-context',
      'process-config',
      'extension-event',
      'session-prompt-file',
      'hook-ephemeral',
    ]),
  }),
  extension: extensionDeliverySchema,
  /**
   * ⚠️ 这一段**必须**在 schema 里,不能只有 TS 类型。
   *
   * `z.object` 默认 strip 未知键,而 `plugins/framework.ts` 存的是 `parsed.data` 而不是作者
   * 写的原字面量 —— schema 里少一个键,那个字段就在运行时**静默消失**:tsc 不红、测试不红、
   * 源码里明明写着,`plugin.capabilities.sessionBundle.coexistence` 却恒为 `undefined`。
   * (这条是四个并行 worker 各自独立踩出来的,不是假想。)
   */
  coexistence: z.object({
    pause: deliverySchema(['protocol-cancel', 'interrupt-key', 'process-signal']),
    observability: deliverySchema(['stream-json', 'acp-update', 'event-stream', 'rpc-stream']),
    askUser: deliverySchema(['mcp-elicitation', 'native-tool', 'permission-ask']),
    introspection: deliverySchema(['config-scan', 'running-engine']),
    history: deliverySchema(['jsonl', 'sqlite', 'server']),
    cron: deliverySchema(['local', 'cloud']),
    todo: deliverySchema(['acp-plan', 'structured-event', 'markdown']),
    memory: deliverySchema(['agents-md', 'vendor-file']),
  }).partial().strict().optional(),
  /**
   * ⚠️ 同 `coexistence`:少了这一条,字段会被 zod **静默** strip 掉 —— 源码里明明写着,
   * `plugin.capabilities.sessionBundle.sessionTuiInterrupt` 却恒为 `undefined`,tsc 与测试全绿。
   */
  sessionTuiInterrupt: sessionTuiInterruptSchema.optional(),
  /** ⚠️ 同上:少了这一条,`sessionTuiQuestionAnswer` 会被 zod 静默剥掉,提问卡就永远只能「去终端答」。 */
  sessionTuiQuestionAnswer: sessionTuiQuestionAnswerSchema.optional(),
  /** ⚠️ 同上:少了这一条,`configRoot` 会被 zod 静默剥掉,独立 home 会**静默**退回用户那份。 */
  configRoot: agentConfigRootSchema.optional(),
  /** ⚠️ 同上:少了这一条,`nativeHome` 会被 zod 静默剥掉,读记录的宿主就找不到这一家的配置根。 */
  nativeHome: z.object({ envVar: z.string().min(1), userPath: z.string().min(1), evidence: z.string().min(1) }).strict().optional(),
  /** ⚠️ 同上:少了这一条,`shellEnv` 会被 zod 静默剥掉,这一家的变量就到不了它的进程。 */
  shellEnv: z.object({
    passThrough: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).optional(),
    denied: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).optional(),
  }).strict().optional(),
  /** ⚠️ 同上:少了这一条,`platform` 会被 zod 静默剥掉(而它是必答字段)。 */
  platform: harnessPlatformSchema,
  /**
   * ⚠️ 同上:少了这一条,`mcpToggle` 会被 zod **静默剥掉** —— 而症状极具迷惑性:
   * descriptor 上明明声明了方言,`/mcp` 面板却把这家判成「咕咕还没有办法关」并置灰所有开关。
   * 也就是**一个正确的实现被自己的校验层否掉**,tsc 与单测全绿。
   * (2026-09-07 实撞:opencode 声明了 `config-content-enabled`,产品面板仍显示「还没有办法」。)
   */
  mcpToggle: z
    .object({
      dialect: z.enum(['config-content-enabled', 'config-arg-enabled', 'disallowed-tools']),
      configArgPrefix: z.string().optional(),
      // ⚠️ 同上:少了这一行,`granularity` 会被 zod **静默剥掉** —— 症状是
      //    claude 的面板渲染成 N 个开关,而用户关掉一台会连带关掉另外几台,且没有任何提示。
      granularity: z.enum(['per-server', 'all-or-none']).optional(),
    })
    .optional(),
  /** ⚠️ 同上:少了这一条,`selfUpdate` 会被 zod 静默剥掉,宿主读到 undefined,会话照旧自更新。 */
  selfUpdate: harnessSelfUpdateControlSchema.optional(),
  /**
   * 必答项 —— ❌ **不给** `.optional()`：没有默认值就是这条规则的全部力气所在（#4834）。
   * ⚠️ 同上:漏进 schema 会被 zod 静默剥掉,于是内核读到 `undefined`、退回「有 configRoot
   *    就算托管」的隐式推导,而 tsc 与测试全绿 —— 那正是本票要根除的形状。
   */
  injectionMode: z.enum(['runtime', 'managed-config-root']),
}).superRefine((descriptor, ctx) => {
  // 两个声明不得互相矛盾。建在 schema 上而不是只放考卷里:每一家 definePlugin 的必经之路。
  const managed = descriptor.injectionMode === 'managed-config-root';
  if (managed !== Boolean(descriptor.configRoot)) {
    ctx.addIssue({
      code: 'custom',
      path: ['injectionMode'],
      message: managed
        ? "injectionMode='managed-config-root' 必须同时声明 configRoot —— 托管这一侧要说清托管的是哪一份配置根"
        : "injectionMode='runtime' 不得声明 configRoot —— 托管配置根只属于非运行时注入那一侧(见 product spec)",
    });
  }
  // 中断键的字节要写进 pty —— 没有终端腿就没有 pty,这条声明连去处都没有。
  // 建在 schema 上而不是只放考卷里:它是每一家 definePlugin 的必经之路,漏不掉。
  // 「有没有终端腿」只认 `declaresSessionTuiLeg` 这一处定义:app-server 那类家(codex)的 pty 挂在
  // `sessionpage['tui']` 上、surfaces 里没有独立的 'tui',直接看 surfaces 会把它判成没有 pty。
  if (descriptor.sessionTuiInterrupt && !declaresSessionTuiLeg(descriptor)) {
    ctx.addIssue({
      code: 'custom',
      path: ['sessionTuiInterrupt'],
      message: 'tui interrupt declared without a terminal leg: the bytes have nowhere to go',
    });
  }
  if (descriptor.sessionTuiQuestionAnswer && !declaresSessionTuiLeg(descriptor)) {
    ctx.addIssue({
      code: 'custom',
      path: ['sessionTuiQuestionAnswer'],
      message: 'tui question answer declared without a terminal leg: the keys have nowhere to go',
    });
  }
  for (const surface of Object.keys(descriptor.runtimeCompatibility ?? {})) {
    if (!descriptor.surfaces.includes(surface as HarnessSessionSurface)) {
      ctx.addIssue({
        code: 'custom',
        path: ['runtimeCompatibility', surface],
        message: `Runtime compatibility is declared for undeclared surface '${surface}'`,
      });
    }
  }
  const requiredSessionAcpRuntime = requiredExactRuntimeCompatibility(descriptor, 'acp');
  if (requiredSessionAcpRuntime) {
    const declaredSessionAcpRuntime = descriptor.runtimeCompatibility?.['acp'];
    if (!declaredSessionAcpRuntime || !matchesRuntimeCompatibility(declaredSessionAcpRuntime, requiredSessionAcpRuntime)) {
      ctx.addIssue({
        code: 'custom',
        path: ['runtimeCompatibility', 'acp'],
        message: `acp event-module adapters require a runtime floor of at least ${requiredSessionAcpRuntime.supportedFloor}`,
      });
    }
  }
});

export const sessionBundleCapability = definePluginCapability<ISessionBundleBehavior>()(
  'session-bundle',
  sessionBundleDescriptorSchema,
  undefined,
  {
    requiresBehavior: (descriptor) => descriptor.surfaces.length > 0,
  }
);
