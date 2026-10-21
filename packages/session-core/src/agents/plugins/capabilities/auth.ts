import { definePluginCapability } from '@gugu/session-shared/plugins';
import z from 'zod';
import type { PluginFs } from '../../runtime/fs';

const cliLoginMethodSchema = z.object({
  kind: z.literal('cli-login'),
  id: z.string(),
  name: z.string(),
  args: z.array(z.string()),
  description: z.string().optional(),
  /**
   * #6264 **在别的机器上**登录用的那条命令的参数(相对这家 CLI)。
   *
   * 别的机器上没有浏览器,而且浏览器开在用户自己这台电脑上 —— 浏览器登完往 `localhost:<端口>` 回跳的那种
   * 登录(codex 默认的 `login`)回不到那台机器,只能用厂商自己给的「不靠回跳」的方式:打印链接 + 一次性码
   * (设备码),或者打印链接、让人把浏览器给的码贴回终端。
   *
   * 声明了才给远程登录;**缺席 = 这家的 CLI 没有经核实的不靠回跳的登录方式**,远程时如实说明、❌ 不硬跑
   * `args`(那会在浏览器里停在一个连不上的 localhost 页)。每一条都要有厂商文档出处。
   */
  headlessArgs: z.array(z.string()).optional(),
});

const apiKeyEnvVarSchema = z.object({
  name: z.string(),
  label: z.string(),
});

const apiKeyMethodSchema = z.object({
  kind: z.literal('api-key'),
  id: z.string(),
  name: z.string(),
  envVars: z.array(apiKeyEnvVarSchema).min(1),
  helpUrl: z.string().optional(),
});

/**
 * 走 harness **自己的协议**登录:咕咕起它的 ACP 进程,发 `initialize` 再发 `authenticate {methodId}`
 * (ACP 规范里的 agent 型登录方法 —— 由 agent 自己完成登录,客户端只负责发起并等它返回)。
 *
 * 用于没有任何登录子命令、只接受协议登录的家(antigravity 的 `agy_acp_server`,#6335):
 * 它收到 `authenticate` 后自己拉起系统浏览器、阻塞到本地 OAuth 回调为止。`cli-login` 对它无从谈起 ——
 * 没有 `<cli> login` 可跑,起一个终端只会是空终端。
 *
 * `methodId` 是 harness 在 `initialize.authMethods` 里自报的 id(逐字);`id` 是咕咕这边的方法 id,
 * 与 `cli-login` 同一套寻址(`startLogin(providerId, id)`)。
 */
const acpAuthenticateMethodSchema = z.object({
  kind: z.literal('acp-authenticate'),
  id: z.string(),
  name: z.string(),
  methodId: z.string().min(1),
  description: z.string().optional(),
});

const authMethodSchema = z.discriminatedUnion('kind', [
  cliLoginMethodSchema,
  apiKeyMethodSchema,
  acpAuthenticateMethodSchema,
]);

/**
 * 伴随程序**自己**的登录(#6335)—— 键是伴随程序的依赖 id(`hostDependency.companions[].id`)。
 *
 * 一家的两条腿可以是 Google 分开发行的两个程序(Antigravity:聊天面板 `agy_acp_server`、终端 `agy`),
 * 而两个程序**不共享登录**(钥匙串里是两条不同的条目,见 impl/antigravity)。所以登录入口与登录状态
 * 按**程序**分,❌ 不按插件合成一份:只报主程序的状态,终端腿会在「已登录」的界面下弹出厂商的登录页;
 * 合成「都登了才算登」,已经登好聊天面板的人又会被告知「没登录」。
 *
 * 顶层 `methods` 仍属主程序(没被伴随程序认领的那几条腿)。这里只放**声明了自己登录**的伴随程序,
 * 没声明的伴随程序没有登录一说(与没声明 auth 的家同一个语义)。
 * 每个键都必须有 `behavior.auth.programs[同一个键]`(宿主在读数/登录时响亮失败,❌ 不回落主程序的判据)。
 */
const programAuthSchema = z.object({
  methods: z.array(authMethodSchema).min(1),
});

export const agentAuthDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('none'),
  }),
  z.object({
    kind: z.literal('supported'),
    methods: z.array(authMethodSchema).min(1),
    programs: z.record(z.string(), programAuthSchema).optional(),
  }),
]);

export type AgentAuthMethod = z.infer<typeof authMethodSchema>;
export type AgentAuthDescriptor = z.infer<typeof agentAuthDescriptorSchema>;
export type AgentProgramAuthDescriptor = z.infer<typeof programAuthSchema>;

export const agentAuthStatusSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('authenticated'),
    account: z.string().optional(),
    /** How the authenticated session is paid for, when the provider can prove it. */
    credentialKind: z.enum(['subscription', 'api-key']).optional(),
  }),
  z.object({
    kind: z.literal('unauthenticated'),
    message: z.string().optional(),
    /**
     * `expired` = 凭据文件还在(CLI 自己答「已登录」),但这家最近一次真去用时被拒了:过期 / 被撤销(#6264)。
     * 由会话里的结构化鉴权失败标上,登录成功或之后某次会话成功时撤掉。缺席 = 就是没登录。
     */
    reason: z.literal('expired').optional(),
  }),
  z.object({
    kind: z.literal('unknown'),
    message: z.string().optional(),
  }),
]);

export type AgentAuthStatus =
  | { kind: 'authenticated'; account?: string; credentialKind?: 'subscription' | 'api-key' }
  | { kind: 'unauthenticated'; message?: string; reason?: 'expired' }
  | { kind: 'unknown'; message?: string };

export type AgentAuthContext = {
  cli: string;
  exec: (
    command: string,
    args?: string[],
    opts?: { timeout?: number; maxBuffer?: number; signal?: AbortSignal }
  ) => Promise<{ stdout: string; stderr: string }>;
  fs: PluginFs;
  env: Record<string, string>;
  /**
   * 「手上这把 `fs` 跟 `env` 里那个配置根**是同一处**吗」。
   *
   * 各家判登录态的读法都是 **home 相对**的(kimi 读 `.kimi-code/config.toml`),而
   * `env` 里可能有一个把配置根挪走的变量(`KIMI_CODE_HOME` 一族)。两者一旦不指向同一处,
   * 读出来的就**不是**引擎真正会读的那份 —— 那时唯一诚实的答案是 `unknown`,
   * ❌ 不是拿一个读错位置的读数去断言「没登录」。
   *
   *  · `false`(默认)—— `fs` 锚在用户真 OS home。`env` 里有那个变量 ⇒ 是**用户自己**
   *    把家挪走了,咕咕照不到,判 `unknown`。
   *  · `true` —— 这一家走**独立 home**:`env` 里那个值是咕咕设的,而 `fs` 正锚在它的
   *    影子 home 上,home 相对的读法**恰好**落在同一份配置里 ⇒ 照常判。
   *
   * ⚠️ 没有这一格的话,独立 home 一上线就会把这些家的登录态**永久**打成 `unknown` ——
   *    变量是咕咕自己设的,而 guard 只看「设没设」。
   */
  fsFollowsConfigRoot?: boolean;
};

/** 一个程序的登录行为:状态怎么判、登录命令怎么起。主程序与伴随程序同一个形状。 */
export type IAgentProgramAuthBehavior = {
  checkStatus(ctx: AgentAuthContext): Promise<AgentAuthStatus>;
  /**
   * `cli-login` 的命令改写。`ctx.cli` 是**这个程序**的可执行文件(宿主按它服务的那条腿解析,
   * 伴随程序就是伴随程序那一份),❌ 不是主程序的。
   */
  buildLoginCommand?(
    ctx: { cli: string },
    methodId: string
  ): { command: string; args: string[] } | null;
};

export type IAgentAuthBehavior = IAgentProgramAuthBehavior & {
  /** 伴随程序各自的登录行为 —— 键与 descriptor 的 `programs` 一一对应(见 `programAuthSchema`)。 */
  programs?: Record<string, IAgentProgramAuthBehavior>;
  /**
   * 这家 harness 自报的某个**自家模型**(如 ACP `session/new` 的 `selected`),它所属 provider
   * 在本机有没有可用凭据。product spec「模型来源与 UI」的默认预选规则消费它:
   * 只有判得出 `'uncredentialed'` 才把新会话的默认预选挪到咕咕平台模型,其余两个值一律维持现状。
   *
   * ⚠️ 与 `checkStatus` 不是同一个问题:后者答「登没登**这家**的账号」,而 opencode 这类
   *    多 provider 引擎可以一个厂商账号都没有、却握着 openai/openrouter 的 key —— 计数式的
   *    「有凭据」判不出「默认模型那条路没凭据」(#4956 的本机复现正是这个形状:auth.json 有
   *    2 条凭据,默认 `opencode/big-pickle` 的 provider `opencode` 却一条都不占)。
   *
   * ⚠️ 读数失败(文件读不出/解析失败/数据根被用户挪走而 fs 照不到)一律 `'unknown'` ——
   *    失败仪器的空输出不是阴性读数;`'unknown'` 的产品后果就是维持这家自家默认,与今天一致。
   */
  modelCredential?(ctx: AgentAuthContext, modelId: string): Promise<HarnessModelCredentialStatus>;
};

/**
 * 「这个自家模型的 provider 有没有本机凭据」的三态。
 * `'unknown'` 是缺省与全部失败路径的落点 —— 消费方对它必须维持现状,❌ 不当 `'uncredentialed'` 用。
 */
export type HarnessModelCredentialStatus = 'credentialed' | 'uncredentialed' | 'unknown';

export const authCapability = definePluginCapability<IAgentAuthBehavior>()(
  'auth',
  agentAuthDescriptorSchema,
  { kind: 'none' },
  {
    requiresBehavior: (descriptor) => descriptor.kind === 'supported',
  }
);
