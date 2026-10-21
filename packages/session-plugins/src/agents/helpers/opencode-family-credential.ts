import type {
  AgentAuthContext,
  AgentAuthStatus,
  HarnessModelCredentialStatus,
} from '@gugu/session-core/agents/plugins';
import { authenticatedFromEnv, outputFromExecError } from './auth';

const AUTH_STATUS_TIMEOUT_MS = 5_000;

/**
 * 家族共用的「哪些环境变量算 provider API key」名单(authenticatedFromEnv 的输入)。
 * ⚠️ 它**不是**品牌差异 —— opencode 与 mimocode 是逐字节 fork,认同一批变量;
 *    两个 impl 各抄一份就会漂(改了一家漏另一家,登录态读数静默分叉),所以钉在这里。
 */
const FAMILY_PROVIDER_API_ENV_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];

/**
 * OpenCode 家族的「登没登」:`<cli> auth list` 的尾行 `N credentials`(fork 输出同形,
 * 实测 `mimo auth list` 与 `opencode auth list` 尾行一字不差)。
 * 这是**计数式**读数,只回答「有没有任何凭据」;按 provider 的判读见下面 modelCredential。
 */
export function opencodeFamilyAuthStatus(
  providerApiEnvVars: string[] = FAMILY_PROVIDER_API_ENV_VARS
): (ctx: AgentAuthContext) => Promise<AgentAuthStatus> {
  return async (ctx) => {
    const envStatus = authenticatedFromEnv(ctx, providerApiEnvVars);
    if (envStatus.kind === 'authenticated') return envStatus;

    try {
      const { stdout, stderr } = await ctx.exec(ctx.cli, ['auth', 'list'], {
        timeout: AUTH_STATUS_TIMEOUT_MS,
      });
      return statusFromAuthListOutput(`${stdout}\n${stderr}`);
    } catch (error) {
      return statusFromAuthListOutput(outputFromExecError(error));
    }
  };
}

export function statusFromAuthListOutput(output: string): AgentAuthStatus {
  const count = credentialCount(output);
  if (count === null) return { kind: 'unknown' };
  return count > 0 ? { kind: 'authenticated' } : { kind: 'unauthenticated' };
}

function credentialCount(output: string): number | null {
  const match = output.match(/\b(\d+)\s+credentials?\b/i);
  return match ? Number(match[1]) : null;
}

/**
 * OpenCode 家族(opencode 及其逐字节 fork mimocode)的「自家默认模型有没有凭据」判读
 * (product spec「模型来源与 UI」的默认预选规则,#4956)。
 *
 * ## 为什么不能用 `auth list` 的凭据计数
 *
 * 这家是多 provider 引擎:模型 id 形如 `<providerID>/<modelID>`,凭据**按 provider 存**在
 * `~/.local/share/<brand>/auth.json`(键就是 providerID —— 实测本机 opencode 的键是
 * `openrouter`/`openai`)。#4956 的本机复现正是「计数 > 0 但默认模型无凭据」:auth.json 有
 * 2 条,默认 `opencode/big-pickle` 的 provider `opencode`(Zen)却一条不占,首句照死。
 * ⇒ 判读必须落到**这个模型的 provider** 上。
 *
 * ## 三个来源,每个失败路径都落 `'unknown'`(失败仪器的空输出不是阴性读数)
 *
 *  1. **auth.json**(`opencode auth login` 的落盘处):键含该 provider ⇒ credentialed。
 *     文件**不存在**是真读数(这台机器从没登过任何 provider),不是仪器失败 —— 继续往下判。
 *  2. **环境变量**:名字来自引擎自己缓存的 models.dev 快照(`~/.cache/<brand>/models.json`
 *     每个 provider 的 `env` 数组;实测 opencode→OPENCODE_API_KEY、openai→OPENAI_API_KEY)。
 *     ❌ 不手抄一张 provider→env 表:那是又一张会漂的表,而引擎手里就有权威的一份。
 *     快照读不出且 auth.json 里也没有 ⇒ env 这根轴没查成 ⇒ `'unknown'`。
 *     (走到这一步的前提是模型目录已 `ready` = 这家真跑起来过 ⇒ 快照按构造已经写过。)
 *  3. **全局配置**(`~/.config/<brand>/<brand>.json[c]`):用户在 `provider` 键下自定义过
 *     这个 provider(inline key / 自建 baseURL)⇒ 咕咕判不了 ⇒ `'unknown'`。
 *
 * 三关都过、该 provider 无凭据可寻 ⇒ `'uncredentialed'`。
 */
export type OpencodeFamilyBrand = {
  /** `~/.local/share/<x>/auth.json` 与 `~/.cache/<x>/models.json` 的目录名。 */
  dataDirName: string;
  /** `~/.config/<x>/<configFileBase>.json[c]` —— 全局配置文件的主名。 */
  configFileBase: string;
  /**
   * 用户把这家数据根挪走的品牌变量(在 agent-env 白名单里的那类,如 `MIMOCODE_HOME`)。
   * 设了而 `fsFollowsConfigRoot` 为假 ⇒ 手上这把 fs 照不到引擎真读的那份 ⇒ `'unknown'`
   * (与 kimi auth 的 guard 同构,理由见 `AgentAuthContext.fsFollowsConfigRoot`)。
   */
  homeEnvVar?: string;
};

async function readJson(ctx: AgentAuthContext, path: string): Promise<
  { kind: 'ok'; value: unknown } | { kind: 'absent' } | { kind: 'unreadable' }
> {
  let content: string | null;
  try {
    content = await ctx.fs.read(path);
  } catch {
    return { kind: 'unreadable' };
  }
  if (content === null) return { kind: 'absent' };
  try {
    return { kind: 'ok', value: JSON.parse(content) };
  } catch {
    // .jsonc 带注释时会走到这里 —— 判不出内容就是判不出,❌ 不为了出结论去猜。
    return { kind: 'unreadable' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function opencodeFamilyModelCredential(
  brand: OpencodeFamilyBrand
): (ctx: AgentAuthContext, modelId: string) => Promise<HarnessModelCredentialStatus> {
  return async (ctx, modelId) => {
    const slash = modelId.indexOf('/');
    if (slash <= 0) return 'unknown';
    const providerId = modelId.slice(0, slash);

    const relocated = brand.homeEnvVar ? ctx.env?.[brand.homeEnvVar]?.trim() : undefined;
    if (relocated && !ctx.fsFollowsConfigRoot) return 'unknown';

    // 1. 已存凭据(auth.json 的键 = providerID)。⚠️ Object.hasOwn,❌ `in`:
    //    后者走原型链,provider 恰好叫 `constructor`/`toString` 时会把空表判成有凭据。
    const auth = await readJson(ctx, `.local/share/${brand.dataDirName}/auth.json`);
    if (auth.kind === 'unreadable') return 'unknown';
    if (auth.kind === 'ok') {
      if (!isRecord(auth.value)) return 'unknown';
      if (Object.hasOwn(auth.value, providerId)) return 'credentialed';
    }

    // 2. 环境变量 —— 变量名单来自引擎自己缓存的 models.dev 快照,❌ 不手抄。
    const models = await readJson(ctx, `.cache/${brand.dataDirName}/models.json`);
    if (models.kind !== 'ok' || !isRecord(models.value)) return 'unknown';
    // 同样 Object.hasOwn:方括号取值也会摸到原型(`['constructor']`)。
    const providerEntry = Object.hasOwn(models.value, providerId)
      ? models.value[providerId]
      : undefined;
    if (!isRecord(providerEntry)) return 'unknown';
    const envNames = Array.isArray(providerEntry.env)
      ? providerEntry.env.filter((name): name is string => typeof name === 'string')
      : [];
    if (envNames.some((name) => Boolean(ctx.env?.[name]?.trim()))) return 'credentialed';

    // 3. 用户全局配置里自定义过这个 provider ⇒ 咕咕判不了它的凭据形态。
    // ⚠️ 已知边界:**项目级** opencode.json 在这里照不到(判读跑在 home 相对的 fs 上,
    //    composer 时刻也没有会话 cwd)。伤害被 models.json 那关兜住一半:自定义 provider
    //    通常不在 models.dev 快照里 ⇒ 第 2 关就落 'unknown'、不改默认;只有「models.dev
    //    在册的 provider + 只在项目级配了 key」才会被误判 uncredentialed —— 后果是预选
    //    落到平台(可见、可当场改回),❌ 不是死路。
    for (const ext of ['json', 'jsonc']) {
      const config = await readJson(ctx, `.config/${brand.dataDirName}/${brand.configFileBase}.${ext}`);
      if (config.kind === 'unreadable') return 'unknown';
      if (config.kind === 'ok' && isRecord(config.value)) {
        const providers = config.value.provider;
        if (isRecord(providers) && Object.hasOwn(providers, providerId)) return 'unknown';
      }
    }

    return 'uncredentialed';
  };
}
