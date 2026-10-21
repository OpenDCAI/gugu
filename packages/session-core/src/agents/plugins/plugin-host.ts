import { err, ok, type Result } from '@gugu/session-shared';
import type { PluginRegistry } from '@gugu/session-shared/plugins';
import { deduplicateRequests, type Scope } from '@gugu/session-wire/util';
import type { IExecutionContext } from '../../exec';
import type { WindowsShimReader } from '../../exec/windows-node-entry';
import {
  applySessionRuntimeCommand,
  assertSessionRuntimeCompatible,
  resolveSessionRuntimeCompatible,
  SessionRuntimeCompatibilityError,
} from './session-runtime-compatibility';
import type { AcpPlatformInjection } from '../../acp/api/runtime-contract';
import {
  agentRunContextKey,
  composeAgentSpawnEnv,
  type AgentRunContext,
  type AgentRunContextError,
} from '../agent-run-context';
import { buildDescriptorsFromProvider } from '../../host-dependencies/descriptor-from-provider';
import {
  HostDependencyManager,
  makeHarnessRuntimeIdentity,
  resolveRealpath,
  runVersionProbe,
  type DependencyDescriptor,
  type HarnessRuntimeIdentity,
  type HostDependencyLedger,
  type InstallMethodDetector,
  type Platform,
} from '../../host-dependencies/runtime';
import type { PluginFs } from '../runtime/fs';
import type { ResolvedAgentHome } from './capabilities/config-root';
import type { AcpSpawnResult, IAcpBehavior } from './capabilities/acp';
import type {
  AgentAuthContext,
  AgentAuthDescriptor,
  AgentAuthMethod,
  AgentAuthStatus,
  IAgentProgramAuthBehavior,
  HarnessModelCredentialStatus,
  IAgentAuthBehavior,
} from './capabilities/auth';
import type { McpServerRegistration } from './capabilities/mcp';
import type { SubscriptionPlanReading, SubscriptionUsageReading } from './capabilities/subscription';
import { readAgentMemoryDocuments, type AgentMemoryDocument } from './capabilities/memory';
import type { AgentCommand, CommandContext } from './capabilities/prompt';
import { declaresSessionTuiLeg, harnessSelfUpdateLaunch } from './capabilities/session-bundle';
import type { AgentConfigRoot, AgentInjectionMode } from './capabilities/session-bundle';
import type {
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
} from './capabilities/session-bundle';
import type { CLIAgentPluginProvider } from './index';

export type ResolvedAcpProvider = {
  behavior: IAcpBehavior;
};

export type ResolvedAuthProvider = {
  name: string;
  auth: AgentAuthDescriptor;
  behavior?: IAgentAuthBehavior;
};

/**
 * 某一个**程序**的登录面(#6335):方法 + 行为。`program` 缺席 = 主程序(顶层 `methods` / `checkStatus`);
 * 给了就是那个伴随程序自己声明的那一份(`auth.programs[program]` / `behavior.auth.programs[program]`)。
 */
export type ResolvedProgramAuth = {
  methods: AgentAuthMethod[];
  behavior: IAgentProgramAuthBehavior | undefined;
};

export type ResolvedTuiProvider = {
  name: string;
  prompt: CLIAgentPluginProvider['capabilities']['prompt'];
  hooks: CLIAgentPluginProvider['capabilities']['hooks'];
  buildCommand: NonNullable<CLIAgentPluginProvider['behavior']['prompt']>['buildCommand'];
  parseHookEvent?: NonNullable<CLIAgentPluginProvider['behavior']['hooks']>['parseHookEvent'];
};

/**
 * 独立 home 的**落盘侧** —— 唯一需要真文件系统的那几件事,由宿主(node 侧 boot)注进来。
 *
 * ⚠️ 之所以注入而不是直接 import:`plugin-host.ts` 是纯逻辑层,`helpers/agent-home.ts` 与
 * `helpers/local-plugin-fs.ts` 都吃 `node:fs`。注入让这一层在测试里能用内存实现跑,
 * 也不把 node 依赖拖进任何打包给渲染进程的路径。
 *
 * 不提供它 = 所有家一律沿用用户的配置根(今天的行为),**声明了 `configRoot` 的家也一样** ——
 * 这是刻意的降级点:宿主没接线时不该悄悄半开。
 */
export type AgentHomeProvisioner = {
  /**
   * 算出并(首次)落盘这一家的独立 home。没声明 `configRoot` 的家给 `null`。
   *
   * ⚠️ **路径拼接也在这一侧**,不在本文件:算路径要 `node:path`,而本文件被
   * `agents/plugins` 的桶导出、进渲染包 —— 加一行 node import 就会让浏览器里
   * 一批不相干的组件测试集体报 `Module "node:path" has been externalized`
   * (2026-08-28 实测,见 `capabilities/config-root.ts` 的注释)。
   */
  provision(
    providerId: string,
    /** ⚠️ 必答:整树复制只属于 `managed-config-root` 那一侧(#4834)。 */
    injectionMode: AgentInjectionMode,
    spec: AgentConfigRoot | undefined
  ): Promise<ResolvedAgentHome | null>;
  /** 为影子 home 造一把 `PluginFs`。见 `helpers/local-plugin-fs.ts`。 */
  createFs(root: string): PluginFs;
};

export type AgentHostDeps = {
  scope: Scope;
  registry: PluginRegistry<CLIAgentPluginProvider>;
  exec: IExecutionContext;
  fs: PluginFs;
  /**
   * ❌ 这里**没有** `env`(#5702)。
   *
   * worker 进程自己那份 `process.env` 是 fork 那一刻的快照,拿它给 agent 拼环境,用户之后改的
   * PATH / 代理 / API key 一个都到不了;而主进程那份是活的。两个属主算同一件事,从来只有一个是对的。
   * ⇒ agent 要带的环境**只能**从随请求递进来的 `AgentRunContext` 里拿,见 `composeAgentSpawnEnv`。
   */
  homeDir: string;
  platform?: Platform;
  /**
   * 这台机器那**一本账**,以及跟着它走的探测器 / 探测环境(#6101)。
   *
   * ❌ 这个进程**不自己建第二本**:没有它的时候,这里的 `HostDependencyManager` 既读不到用户
   * 选的是哪一份、也不知道哪些目录是咕咕自己的 ⇒ `ours` 恒 false、`manageable` 恒 false,
   * 而主进程对同一台机器上同一家给的是另一套读数。两份读数里从来只有一份是对的,
   * 界面却分不出是哪一份。⇒ 账由属主(桌面端主进程)递进来,这里只读。
   */
  hostDependencies?: {
    ledger?: HostDependencyLedger;
    installMethodDetector?: InstallMethodDetector;
    resolveProbeEnv?: (
      descriptor: DependencyDescriptor
    ) => Promise<Record<string, string> | undefined>;
  };
  /** 见 `AgentHomeProvisioner`。不给 = 独立 home 整套不启用。 */
  agentHome?: AgentHomeProvisioner;
  /**
   * 读 Windows `.cmd` 壳的那一半(#6390):经 node 起的家要从壳里读出 JS 入口再交给 node。
   * 本文件在 web 构建里,❌ 自己 import `node:fs`;由 node 侧的 boot 递 `diskWindowsShimReader`。
   */
  windowsShimReader?: WindowsShimReader;
  /** Provider-boundary environment additions (for example managed OpenCode XDG homes). */
  resolveProviderEnv?: (providerId: string) => Promise<Record<string, string>> | Record<string, string>;
};

export type AgentHostError =
  | AgentRunContextError
  | SessionRuntimeCompatibilityError
  | { type: 'capability-unsupported'; providerId: string; capability: string }
  | { type: 'invalid-state'; message: string };

export type AgentHostLoginCommand = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type AgentHostAcpSpawn = AcpSpawnResult & {
  env: Record<string, string>;
  cwd: string;
};

export class AgentPluginHost {
  readonly dependencies: HostDependencyManager;

  private readonly scope: Scope;
  private readonly registry: PluginRegistry<CLIAgentPluginProvider>;
  private readonly descriptors: ReturnType<typeof buildDescriptorsFromProvider>;
  private readonly checkAuthStatusOnce: (input: {
    providerId: string;
    runContext: AgentRunContext;
    program: string | undefined;
  }) => Promise<Result<AgentAuthStatus, AgentHostError>>;
  private readonly modelCredentialOnce: (input: {
    providerId: string;
    modelId: string;
    runContext: AgentRunContext;
  }) => Promise<Result<HarnessModelCredentialStatus, AgentHostError>>;
  /** 独立 home 每家只算/只复制一次。见 `provisionAgentHome`。 */
  private readonly agentHomeOnce = new Map<string, Promise<ResolvedAgentHome | null>>();

  constructor(private readonly deps: AgentHostDeps) {
    this.scope = deps.scope.child('agent-host');
    this.registry = deps.registry;
    // 伴随程序各占一行(#6335):worker 那本账也要认得「终端腿那个程序装没装」。
    this.descriptors = deps.registry.getAll().flatMap(buildDescriptorsFromProvider);
    this.dependencies = new HostDependencyManager(deps.exec, {
      platform: deps.platform,
      dependencies: this.descriptors,
      getDependencyDescriptor: (id) => this.descriptors.find((descriptor) => descriptor.id === id),
      logger: this.scope.log,
      // 账 / 探测器 / 探测环境全部由属主递进来(#6101)。一个都不给时它仍然能探,
      // 但那时它答的是「这台机器上 PATH 赢家是什么」,而不是「咕咕在用哪一份」。
      ...(deps.hostDependencies?.ledger ? { ledger: deps.hostDependencies.ledger } : {}),
      ...(deps.hostDependencies?.installMethodDetector
        ? { installMethodDetector: deps.hostDependencies.installMethodDetector }
        : {}),
      ...(deps.hostDependencies?.resolveProbeEnv
        ? { resolveProbeEnv: deps.hostDependencies.resolveProbeEnv }
        : {}),
    });
    this.scope.use(deps.exec);
    // 在途去重按「这一家 × 这一份运行上下文」(#5683 / #5702):换了拷贝、改了设置里的 env
    // 之后的那次读数,❌ 不许并进换之前那次。
    // 程序也进键(#6335):同一家两个程序的读数是两件事,❌ 并进同一趟。
    this.checkAuthStatusOnce = deduplicateRequests(
      (input: { providerId: string; runContext: AgentRunContext; program: string | undefined }) =>
        this.checkAuthStatusUncached(input.providerId, input.runContext, input.program),
      {
        key: (input) =>
          `${input.providerId}\u0000${input.program ?? ''}\u0000${agentRunContextKey(input.runContext)}`,
      }
    );
    this.modelCredentialOnce = deduplicateRequests(
      (input: { providerId: string; modelId: string; runContext: AgentRunContext }) =>
        this.modelCredentialUncached(input.providerId, input.modelId, input.runContext),
      {
        key: (input) =>
          `${input.providerId}\u0000${input.modelId}\u0000${agentRunContextKey(input.runContext)}`,
      }
    );
  }

  /**
   * 用户**真 OS home** 上的那把 fs。跨家共用的东西(skills 一族)读它。
   * ⚠️ ❌ 别拿它读写**某一家自己的**配置:声明了 `configRoot` 的家在别处 —— 用 `fsFor`。
   */
  get fs(): PluginFs {
    return this.deps.fs;
  }

  get homeDir(): string {
    return this.deps.homeDir;
  }

  /**
   * 这一家配置该往哪儿读写。声明了 `configRoot` 的家给它**影子 home** 那把,其余给 `this.fs`。
   *
   * ⚠️ 异步是因为第一次会顺带把用户那份**复制过来**(见 `helpers/agent-home.ts` 的时机那一段);
   *    之后 memo 命中,不再碰盘。
   */
  async fsFor(providerId: string): Promise<PluginFs> {
    const home = await this.provisionAgentHome(providerId);
    if (!home || !this.deps.agentHome) return this.fs;
    return this.deps.agentHome.createFs(home.shadowHome);
  }

  /** 这一家眼里的「home」。独立 home 的家 = 影子 home;其余 = 用户真 OS home。 */
  async homeDirFor(providerId: string): Promise<string> {
    const home = await this.provisionAgentHome(providerId);
    return home?.shadowHome ?? this.homeDir;
  }

  /**
   * 算出并(首次)落盘这一家的独立 home。**每家只做一次** —— memo 的是 promise,
   * 所以并发触碰也只复制一次。
   */
  private provisionAgentHome(providerId: string): Promise<ResolvedAgentHome | null> {
    const cached = this.agentHomeOnce.get(providerId);
    if (cached) return cached;
    const task = (async (): Promise<ResolvedAgentHome | null> => {
      const provisioner = this.deps.agentHome;
      if (!provisioner) return null;
      const bundle = this.registry.get(providerId)?.capabilities.sessionBundle;
      if (!bundle) return null;
      // ❌ 别退回「有 configRoot 就算托管」的隐式推导(#4834):走哪一侧由这家自己声明。
      if (bundle.injectionMode !== 'managed-config-root') return null;
      return provisioner.provision(providerId, bundle.injectionMode, bundle.configRoot);
    })();
    this.agentHomeOnce.set(providerId, task);
    return task;
  }

  get(providerId: string): CLIAgentPluginProvider | undefined {
    return this.registry.get(providerId);
  }

  getAll(): CLIAgentPluginProvider[] {
    return this.registry.getAll();
  }

  resolveAcp(providerId: string): ResolvedAcpProvider | null {
    const plugin = this.registry.get(providerId);
    if (!plugin || plugin.capabilities.acp.kind !== 'supported' || !plugin.behavior.acp) {
      return null;
    }

    return { behavior: plugin.behavior.acp };
  }

  resolveAuthProvider(providerId: string): ResolvedAuthProvider | null {
    const plugin = this.registry.get(providerId);
    if (!plugin) return null;

    return {
      name: plugin.metadata.name,
      auth: plugin.capabilities.auth,
      behavior: plugin.behavior.auth,
    };
  }

  /**
   * 某个程序的登录面(#6335)。`program` 缺席 = 主程序。
   *
   * 伴随程序那一路三样都要对上,缺一样都是插件写错了 ⇒ `invalid-state`,❌ 不回落主程序:
   * 回落就是拿聊天面板那个程序的凭据去答「终端那个程序登没登」—— 两者不共享登录。
   *  · 它是这一家声明过的伴随程序(`hostDependency.companions[].id`);
   *  · `auth.programs[program]` 声明了它的登录方法;
   *  · `behavior.auth.programs[program]` 给了判据。
   */
  resolveProgramAuth(
    providerId: string,
    program?: string
  ): Result<ResolvedProgramAuth | null, AgentHostError> {
    const provider = this.resolveAuthProvider(providerId);
    if (!provider) return err({ type: 'unknown-provider', providerId });
    if (program === undefined) {
      return ok(
        provider.auth.kind === 'supported'
          ? { methods: provider.auth.methods, behavior: provider.behavior }
          : null
      );
    }
    const plugin = this.registry.get(providerId)!;
    const companion = plugin.capabilities.hostDependency.companions?.find((entry) => entry.id === program);
    const declared = provider.auth.kind === 'supported' ? provider.auth.programs?.[program] : undefined;
    const behavior = provider.behavior?.programs?.[program];
    if (!companion || !declared || !behavior) {
      return err({
        type: 'invalid-state',
        message: `Provider '${providerId}' has no sign-in declared for program '${program}'`,
      });
    }
    return ok({ methods: declared.methods, behavior });
  }

  resolveTuiProvider(providerId: string): ResolvedTuiProvider | null {
    const plugin = this.registry.get(providerId);
    const prompt = plugin?.behavior.prompt;
    if (!plugin || !prompt) return null;

    return {
      name: plugin.metadata.name,
      prompt: plugin.capabilities.prompt,
      hooks: plugin.capabilities.hooks,
      buildCommand: prompt.buildCommand,
      parseHookEvent: plugin.behavior.hooks?.parseHookEvent,
    };
  }

  dispose(): Promise<void> {
    return this.scope.dispose();
  }

  /**
   * 登录状态 —— 读的是**宿主定的那份 CLI**(#5683)。各家的判断大多就是跑一次 `<cli> auth status`,
   * 而切账号 wrapper 正是靠 CLI 本身把配置根指过去;拿 PATH 上那份去问,答的是另一个账号。
   */
  checkAuthStatus(
    providerId: string,
    runContext: AgentRunContext,
    /**
     * 问的是哪个程序(#6335)—— 缺席 = 主程序。给了伴随程序时,`runContext` 必须是**那个程序**的
     * (主进程按它服务的腿解析,见 desktop `withHostResolvedCli`)。
     */
    program?: string
  ): Promise<Result<AgentAuthStatus, AgentHostError>> {
    return this.checkAuthStatusOnce({ providerId, runContext, program });
  }

  /**
   * 这家自报的某个自家模型,其 provider 在本机有没有凭据(product spec 默认预选规则)。
   *
   * 没实现这个行为的家答 `'unknown'` —— 消费方维持它自家默认,与今天逐字节一致。
   * ⚠️ ctx 的构造与 `checkAuthStatusUncached` 同一套(fs/home 配对、provider env 叠放),
   *    ❌ 别在别处重抄一份:两份就会漂,而漂掉的正是 fs 与 env 指向是否同一处那对保证。
   * 与 `checkAuthStatusOnce` 同一个理由做在途去重:并发的同参调用(两个窗口的 composer、
   * 重挂载撞上 refetch)不该各自跑一遍 spawn 解析 + 2–4 次文件读 + 整份 models.json 解析。
   */
  modelCredential(
    providerId: string,
    modelId: string,
    runContext: AgentRunContext
  ): Promise<Result<HarnessModelCredentialStatus, AgentHostError>> {
    return this.modelCredentialOnce({ providerId, modelId, runContext });
  }

  /**
   * 「订阅」页的两格读数(product spec):谁付钱 + 套餐、这一期还剩多少。
   *
   * ctx 与登录读数同一套(宿主定的 CLI、按家的 fs、`fsFollowsConfigRoot` 成对给)—— 读的必须是这家会话
   * 真会用的那一份凭据。没声明 `subscription` 的家答 `unknown` / `unavailable`,❌ 报错:那是读数本身。
   * 用量读数把套餐读数一起交给插件，由它决定问不问(只有订阅才去问厂商)。
   */
  async readSubscription(
    providerId: string,
    runContext: AgentRunContext
  ): Promise<Result<SubscriptionPlanReading, AgentHostError>> {
    if (!this.registry.get(providerId)) return err({ type: 'unknown-provider', providerId });
    const behavior = this.subscriptionBehavior(providerId);
    if (!behavior) return ok({ payer: 'unknown' });
    const ctx = await this.credentialContext(providerId, runContext);
    if (!ctx.success) return ctx;
    return ok(await behavior.readPlan(ctx.data));
  }

  async readSubscriptionUsage(
    providerId: string,
    runContext: AgentRunContext
  ): Promise<Result<SubscriptionUsageReading, AgentHostError>> {
    if (!this.registry.get(providerId)) return err({ type: 'unknown-provider', providerId });
    const behavior = this.subscriptionBehavior(providerId);
    if (!behavior) return ok({ kind: 'unavailable', reason: 'not-reported', readAt: Date.now() });
    const ctx = await this.credentialContext(providerId, runContext);
    if (!ctx.success) return ctx;
    return ok(await behavior.readUsage(ctx.data, await behavior.readPlan(ctx.data)));
  }

  private subscriptionBehavior(providerId: string) {
    const provider = this.registry.get(providerId);
    if (provider?.capabilities.subscription.kind !== 'supported') return undefined;
    return provider.behavior?.subscription;
  }

  private async credentialContext(
    providerId: string,
    runContext: AgentRunContext
  ): Promise<Result<AgentAuthContext, AgentHostError>> {
    const cli = this.hostCli(providerId, runContext);
    if (!cli.success) return err(cli.error);
    const home = await this.provisionAgentHome(providerId);
    const env = composeAgentSpawnEnv(runContext, {
      providerEnv: await this.deps.resolveProviderEnv?.(providerId),
    });
    if (runContext.credentialHome && !this.deps.agentHome) {
      throw new Error('The host cannot read the selected credential home');
    }
    return ok({
      cli: cli.data,
      exec: (command, args, opts) => this.deps.exec.exec(command, args, { ...opts, env }),
      fs: runContext.credentialHome
        ? this.deps.agentHome!.createFs(runContext.credentialHome)
        : await this.fsFor(providerId),
      env,
      fsFollowsConfigRoot: Boolean(runContext.credentialHome) || home !== null,
    });
  }

  private async modelCredentialUncached(
    providerId: string,
    modelId: string,
    runContext: AgentRunContext
  ): Promise<Result<HarnessModelCredentialStatus, AgentHostError>> {
    const provider = this.resolveAuthProvider(providerId);
    if (!provider) return err({ type: 'unknown-provider', providerId });
    const judge = provider.behavior?.modelCredential;
    if (!judge) return ok('unknown');

    const ctx = await this.credentialContext(providerId, runContext);
    if (!ctx.success) return ctx;
    return ok(await judge(ctx.data, modelId));
  }

  /**
   * 登录命令跑的是宿主定的那份 CLI(#5683):登进哪个账号,由它指向的配置根决定。
   *
   * `headless`(#6264):这次登录是从**别的电脑**发起的,浏览器不在这台机器上 —— 只能用这家声明的
   * `headlessArgs`(设备码 / 把码贴回终端);没声明就拒,❌ 退回 `args`(那条回跳 localhost 的登录在
   * 这里完成不了,人会在浏览器里停在一个连不上的页)。
   */
  async buildLoginCommand(
    providerId: string,
    methodId: string,
    runContext: AgentRunContext,
    /** 登哪个程序(#6335),缺席 = 主程序。`runContext` 须是那个程序的(同 `checkAuthStatus`)。 */
    program?: string,
    options: { headless?: boolean } = {}
  ): Promise<Result<AgentHostLoginCommand, AgentHostError>> {
    const provider = this.resolveAuthProvider(providerId);
    if (!provider) return err({ type: 'unknown-provider', providerId });
    const programAuth = this.resolveProgramAuth(providerId, program);
    if (!programAuth.success) return programAuth;

    const cli = this.hostCli(providerId, runContext);
    if (!cli.success) return err(cli.error);
    const env = composeAgentSpawnEnv(runContext, {
      providerEnv: await this.deps.resolveProviderEnv?.(providerId),
    });

    if (programAuth.data === null) {
      if (methodId !== 'cli-login') {
        return err({
          type: 'invalid-state',
          message: `Auth method '${methodId}' was not found for provider '${providerId}'`,
        });
      }
      return ok({ command: cli.data, args: [], env });
    }

    const method = programAuth.data.methods.find((candidate) => candidate.id === methodId);
    if (!method) {
      return err({
        type: 'invalid-state',
        message: `Auth method '${methodId}' was not found for provider '${providerId}'`,
      });
    }
    if (method.kind !== 'cli-login') {
      return err({
        type: 'invalid-state',
        message: `Auth method '${methodId}' is not a CLI login method`,
      });
    }

    if (options.headless) {
      if (!method.headlessArgs) {
        return err({
          type: 'invalid-state',
          message: `Auth method '${methodId}' of provider '${providerId}' has no headless sign-in`,
        });
      }
      return ok({ command: cli.data, args: method.headlessArgs, env });
    }
    const override = programAuth.data.behavior?.buildLoginCommand?.({ cli: cli.data }, methodId);
    return ok({
      command: override?.command ?? cli.data,
      args: override?.args ?? method.args,
      env,
    });
  }

  async readMcpServers(
    providerId: string
  ): Promise<Result<McpServerRegistration[], AgentHostError>> {
    const behavior = this.resolveMcpBehavior(providerId);
    if (!behavior.success) return behavior;
    return ok(await behavior.data.readServers(await this.fsFor(providerId)));
  }

  async writeMcpServers(
    providerId: string,
    servers: McpServerRegistration[]
  ): Promise<Result<void, AgentHostError>> {
    const behavior = this.resolveMcpBehavior(providerId);
    if (!behavior.success) return behavior;
    await behavior.data.writeServers(await this.fsFor(providerId), servers);
    return ok();
  }

  async removeMcpServer(providerId: string, name: string): Promise<Result<void, AgentHostError>> {
    const behavior = this.resolveMcpBehavior(providerId);
    if (!behavior.success) return behavior;
    await behavior.data.removeServer(await this.fsFor(providerId), name);
    return ok();
  }

  /**
   * 读某一家 agent **自己会去读**的记忆文件(`CLAUDE.md` / `AGENTS.md` / `.cursor/rules` 一族)。
   *
   * ⚠️ 只有读口,没有写口 —— 理由钉在 `capabilities/memory.ts` 的 `AgentMemoryDescriptor` 上。
   *
   * ⚠️ `target` 之所以把 project 的 fs 做成必填,是因为宿主这把 `this.fs` 恒锚在 home
   * (三处构造点全是 `createLocalPluginFs(homeDir)`),而 `local-plugin-fs.ts` 的 `resolveSafe`
   * 对越出 root 的路径直接抛异常。给 project 一个默认值只会让调用方静默读到空,
   * 所以做成类型上躲不开:project 必须自带一把锚在工作区根的 fs
   * (house style 见 `hook-config-service.ts:65` —— 调用方按 scope 现造 fs)。
   *
   * 未声明 memory 的家返回空数组,**不是错误**:那只说明咕咕还没为它登记记忆文件。
   */
  async readMemoryFiles(
    providerId: string,
    target: { scope: 'global' } | { scope: 'project'; fs: PluginFs }
  ): Promise<Result<AgentMemoryDocument[], AgentHostError>> {
    const provider = this.registry.get(providerId);
    if (!provider) return err({ type: 'unknown-provider', providerId });
    const fs = target.scope === 'global' ? await this.fsFor(providerId) : target.fs;
    return ok(await readAgentMemoryDocuments(provider.capabilities.memory, target.scope, fs));
  }

  /**
   * 终端腿的启动命令 —— 跑的是**宿主定的那份 CLI**(#5702)。
   *
   * `runContext` 必填:这条腿上 worker 自己**没有**探测的能力了,忘记带宿主的答案会编译不过,
   * 而不是像 #5548 / #5681 / #5683 那样静默退回 PATH 上谁先谁后。
   */
  async buildPromptCommand(
    providerId: string,
    ctx: Omit<CommandContext, 'cli'>,
    runContext: AgentRunContext
  ): Promise<Result<AgentCommand, AgentHostError>> {
    const plugin = this.registry.get(providerId);
    if (!plugin) return err({ type: 'capability-unsupported', providerId, capability: 'prompt' });
    const sessionBundle = plugin.capabilities.sessionBundle;
    if (!declaresSessionTuiLeg(sessionBundle)) {
      return err({
        type: 'capability-unsupported',
        providerId,
        capability: 'sessionBundle:tui',
      });
    }
    const provider = this.resolveTuiProvider(providerId);
    if (!provider) return err({ type: 'capability-unsupported', providerId, capability: 'prompt' });
    const cli = this.hostCli(providerId, runContext);
    if (!cli.success) return err(cli.error);
    let command = provider.buildCommand({
      ...ctx,
      cli: cli.data,
      // 用户在 Agents 设置里填的额外参数由宿主带进来(#5702)。从前这一格只有终端腿的
      // `local-session.ts` 自己读设置填得上,worker 侧这条路一直是空的。
      extraArgs: [...runContext.extraArgs, ...(ctx.extraArgs ?? [])],
    });
    // 关自更新走 argv 的家(#6186):与本机终端腿同一份声明、同一个位置(命令行尾部)。
    const selfUpdateArgs = harnessSelfUpdateLaunch(sessionBundle).args;
    if (selfUpdateArgs.length > 0) command = { ...command, args: [...command.args, ...selfUpdateArgs] };
    try {
      const runtime = await resolveSessionRuntimeCompatible({
        providerId,
        surface: 'tui',
        descriptor: plugin.capabilities.sessionBundle,
        executable: cli.data,
        executionContext: this.deps.exec,
        // 探的是将要跑的那份,环境也用将要带的那份(#5702)。
        env: composeAgentSpawnEnv(runContext),
        runtimeExecutable: runContext.runtimeExecutable,
        windowsShimReader: this.deps.windowsShimReader,
      });
      command = applySessionRuntimeCommand(command, {
        harnessExecutable: runtime.executable,
        runtimeExecutable: runtime.runtimeExecutable,
      });
    } catch (error) {
      if (error instanceof SessionRuntimeCompatibilityError) return err(error);
      throw error;
    }
    return ok({
      ...command,
      env: composeAgentSpawnEnv(runContext, {
        providerEnv: {
          ...(await this.deps.resolveProviderEnv?.(providerId)),
          ...command.env,
        },
      }),
    });
  }

  async buildAcpSpawn(
    providerId: string,
    ctx: {
      cwd: string;
      /**
       * 宿主替这次会话定好的 CLI(#5681)。必填:worker 侧已经没有自己探测的那一路(#5702),看不见用户在
       * 设置里选的那份拷贝,❌ 缺席时退回它 —— 那正是「终端跑 A、Chat UI 跑 B」的由来。
       */
      runContext: AgentRunContext;
      platform?: AcpPlatformInjection;
      capabilitySpawnEnv?: Readonly<Record<string, string>>;
      capabilitySpawnArgs?: readonly string[];
      /** 这次会话启动的寿命:启动被放弃时收掉仍在跑的版本探针。 */
      signal?: AbortSignal;
    }
  ): Promise<Result<AgentHostAcpSpawn, AgentHostError>> {
    const provider = this.resolveAcp(providerId);
    if (!provider) return err({ type: 'capability-unsupported', providerId, capability: 'acp' });
    const hostCli = this.hostCli(providerId, ctx.runContext);
    if (!hostCli.success) return err(hostCli.error);
    const plugin = this.registry.get(providerId);
    if (!plugin) return err({ type: 'unknown-provider', providerId });
    let cli: string;
    try {
      cli = await assertSessionRuntimeCompatible({
        providerId,
        surface: 'acp',
        descriptor: plugin.capabilities.sessionBundle,
        executable: hostCli.data,
        executionContext: this.deps.exec,
        // 同上(#5702)。
        env: composeAgentSpawnEnv(ctx.runContext),
        runtimeExecutable: ctx.runContext.runtimeExecutable,
        signal: ctx.signal,
      });
    } catch (error) {
      if (error instanceof SessionRuntimeCompatibilityError) return err(error);
      throw error;
    }
    const spawn = provider.behavior.buildSpawn({
      cwd: ctx.cwd,
      env: composeAgentSpawnEnv(ctx.runContext),
      cli,
      platform: ctx.platform,
      // 见 `AcpSpawnContext.capabilityEnv`:递进去是为了让 buildSpawn 能**读**物化器决定的事实,
      // 而不是让物化器去复制一份 buildSpawn 的输出。下面那行 `...ctx.capabilitySpawnEnv`
      // 仍然叠在最上面,顺序没变。
      ...(ctx.capabilitySpawnEnv ? { capabilityEnv: ctx.capabilitySpawnEnv } : {}),
      ...(ctx.capabilitySpawnArgs ? { capabilityArgs: ctx.capabilitySpawnArgs } : {}),
      ...(ctx.runContext.acpAdapterEntry ? { adapterEntry: ctx.runContext.acpAdapterEntry } : {}),
    });
    return ok({
      ...spawn,
      env: composeAgentSpawnEnv(ctx.runContext, {
        providerEnv: {
          ...(await this.deps.resolveProviderEnv?.(providerId)),
          ...spawn.env,
        },
        hostInjections: [ctx.capabilitySpawnEnv],
      }),
      cwd: ctx.cwd,
    });
  }

  /** Probe the harness selected by a completed ACP spawn resolution. This has no logging or launch
   * policy of its own; the real session-start boundary owns the diagnostic record. */
  async probeAcpSpawnRuntimeIdentity(
    providerId: string,
    spawn: AgentHostAcpSpawn
  ): Promise<HarnessRuntimeIdentity | null> {
    const executable = spawn.executable;
    if (!executable) return null;
    const realpath = await resolveRealpath(executable, this.deps.exec);
    // 探的是这次 spawn 解析出来的那一份,环境也用它这次真要带的那份(#5702)。
    const probe = await runVersionProbe(executable, realpath, ['--version'], this.deps.exec, {
      env: spawn.env,
    });
    return makeHarnessRuntimeIdentity({ providerId, executable: realpath, probe });
  }

  async materializeSessionBundle(
    providerId: string,
    ctx: SessionMaterializationContext,
    bundle: SessionCapabilityBundle
  ): Promise<Result<SessionMaterialization, AgentHostError>> {
    const provider = this.registry.get(providerId);
    if (!provider) return err({ type: 'unknown-provider', providerId });
    if (!provider.capabilities.sessionBundle.surfaces.includes(ctx.surface)) {
      return err({
        type: 'capability-unsupported',
        providerId,
        capability: `sessionBundle:${ctx.surface}`,
      });
    }
    const behavior = provider.behavior.sessionBundle;
    if (!behavior) {
      return err({
        type: 'invalid-state',
        message: `Provider '${providerId}' declares session bundle surfaces without behavior`,
      });
    }
    return ok(behavior.materialize(ctx, bundle));
  }

  /**
   * 宿主定好的那份 CLI(#5681 / #5683 / #5702):`unresolved` 原样报成 `cli-not-found`。
   *
   * 本进程**没有**自己探测的那一路了 —— `spawn-context.ts` 连同它的 `resolveCli`、cli 缓存、
   * 自建 env 一起删掉了。忘记带宿主答案的调用点编译不过,而不是静默退回 PATH 上谁先谁后。
   */
  private hostCli(
    providerId: string,
    runContext: AgentRunContext
  ): Result<string, AgentHostError> {
    if (!this.registry.get(providerId)) return err({ type: 'unknown-provider', providerId });
    if (runContext.cli.kind === 'unresolved') {
      return err({ type: 'cli-not-found', providerId, message: runContext.cli.message });
    }
    return ok(runContext.cli.path);
  }

  private async checkAuthStatusUncached(
    providerId: string,
    runContext: AgentRunContext,
    program: string | undefined
  ): Promise<Result<AgentAuthStatus, AgentHostError>> {
    const programAuth = this.resolveProgramAuth(providerId, program);
    if (!programAuth.success) return programAuth;
    const behavior = programAuth.data?.behavior;
    if (!behavior) return ok({ kind: 'unknown' });

    const ctx = await this.credentialContext(providerId, runContext);
    if (!ctx.success) return ctx;
    return ok(await behavior.checkStatus(ctx.data));
  }

  private resolveMcpBehavior(
    providerId: string
  ): Result<NonNullable<CLIAgentPluginProvider['behavior']['mcp']>, AgentHostError> {
    const provider = this.registry.get(providerId);
    if (!provider) return err({ type: 'unknown-provider', providerId });
    if (provider.capabilities.mcp.kind !== 'supported' || !provider.behavior.mcp) {
      return err({ type: 'capability-unsupported', providerId, capability: 'mcp' });
    }
    return ok(provider.behavior.mcp);
  }
}
