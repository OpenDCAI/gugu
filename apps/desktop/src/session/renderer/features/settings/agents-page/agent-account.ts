import type { AuthStatusModelState } from '@gugu/session-core/workspace-server/agent-config';
import type {
  AgentCapabilities,
  AgentPayload,
  DependencyStatus,
} from '@shared/core/agents/agent-payload';
import type { SessionpageLeg } from '@shared/core/sessions/sessions';

type AuthMethod = Extract<AgentCapabilities['auth'], { kind: 'supported' }>['methods'][number];

/**
 * 产品里真能发起登录的两种方法:
 *  · `cli-login` —— 起一个终端跑厂商的 `<cli> login`(`plugin-host.ts` 的 `buildLoginCommand`);
 *  · `acp-authenticate` —— 起它的 ACP 进程发 `authenticate`,浏览器由厂商自己拉起(#6335)。
 * `api-key` 不在其列:咕咕没有填 key 的界面。
 */
export type SignInMethod = Extract<AuthMethod, { kind: 'cli-login' | 'acp-authenticate' }>;

/**
 * 「这一家能不能在咕咕里登录」——**唯一**一份判据。
 *
 * 从前 composer(`initial-session-section.tsx`)和会话页(`acp-chat-panel.tsx`)各写了一遍
 * 同一个 find,空值还一个给 `null` 一个给 `undefined`。现在抽屉的 Account 行是第三处消费者,
 * 再抄一遍就是三种脾气。
 *
 * ⚠️ 判据是「声明了一种**能跑**的登录方法」,❌ 不是「声明了 auth」:只写 `api-key` 的家在产品里
 *    **没有任何可达的登录动作**,给它画一颗「登录」按钮就是 fake。
 * ⚠️ 声明了好几种时取**声明顺序里的第一个** —— 插件把它最推荐的那种写在前面。几种都是同一家的不同账号体系
 *    (CodeBuddy 国际版 / 中国版)时由用户挑,挑的那一步在登录弹窗里(`AgentSignInModal`),读的是下面那份全集。
 */
export function resolveSignInMethod(
  capabilities: AgentCapabilities | null | undefined,
  /** 哪个程序的登录(#6335)。缺席 = 主程序;给了 = 那个伴随程序在 `auth.programs` 里自己声明的那份。 */
  program?: string
): SignInMethod | null {
  return resolveSignInMethods(capabilities, program)[0] ?? null;
}

/** 这个程序能在咕咕里发起的**全部**登录方法,按声明顺序。 */
export function resolveSignInMethods(
  capabilities: AgentCapabilities | null | undefined,
  program?: string
): SignInMethod[] {
  // `auth?.` 而不是 `auth.` —— payload 里这一格总在,但调用点拿到的可能是一份**部分**
  // capabilities(测试夹具、以及 providerError 时被刻意打成 null 的那条路)。少了这个 `?`
  // 整个 composer 会在渲染里摔掉。
  if (capabilities?.auth?.kind !== 'supported') return [];
  const methods =
    program === undefined ? capabilities.auth.methods : capabilities.auth.programs?.[program]?.methods;
  return (methods ?? []).filter(
    (m): m is SignInMethod => m.kind === 'cli-login' || m.kind === 'acp-authenticate'
  );
}

/**
 * 「在这条腿上登录」登的是哪个程序、用哪个方法(#6335)。
 *
 * 一家的两条腿可以是两个程序(Antigravity:聊天面板 `agy_acp_server`、终端 `agy`),两者不共享登录 ——
 * 终端腿要问的是 `agy` 的登录,❌ 不是聊天面板那个的,反之亦然。
 *
 *  · 这条腿被某个伴随程序认领(`programs` 里除第一行外,`legs` 含它)⇒ 那个程序;它没在
 *    `auth.programs` 里声明自己的登录 ⇒ `null`(那条腿没有能在咕咕里发起的登录)。
 *  · 否则是主程序 ⇒ `program: undefined` + 顶层方法(没有伴随程序的家全走这条,与从前逐字节一致)。
 */
export type SignInTarget = { program: string | undefined; method: SignInMethod };

export function resolveSignInTarget(
  agent: Pick<AgentPayload, 'capabilities' | 'programs'> | null | undefined,
  leg: SessionpageLeg
): SignInTarget | null {
  const companion = agent?.programs?.slice(1).find((program) => program.legs.includes(leg));
  const program = companion?.dependencyId;
  const method = resolveSignInMethod(agent?.capabilities, program);
  return method ? { program, method } : null;
}

/**
 * Account 行的四态。
 *
 * `checking` 与 `unknown` **不是**一回事,所以没有合成一个:前者是「还没读到」(探测在途),
 * 后者是「读了,但判不出」(harness 自己答 unknown / CLI 解析不出 / 配置根被挪走)。
 * 把在途渲染成「未知」= 拿一个没有的读数冒充读数。
 */
export type AccountStatus = 'signed-in' | 'signed-out' | 'expired' | 'unknown' | 'checking';

/**
 * 资源库那一行的状态 —— 比单个程序多一态 `partial`(#6335):一家几个程序、有的登了有的没登。
 * 那时既不能说「已登录」(没登的那条腿一起会话就要登录),也不能说「未登录」(已经登上的那部分是真的)。
 */
export type MergedAccountStatus = AccountStatus | 'partial';

export type AccountRow = {
  /** 登哪个程序(#6335);缺席 = 主程序。 */
  program?: string;
  /**
   * 这个程序服务哪几条腿。只有一家分成几个程序时才给(界面据此给每一行标上「通用 / 编程」);
   * 单程序的家是 null —— 一行就是这一家,❌ 不多挂一个标签。
   */
  legs: SessionpageLeg[] | null;
  method: SignInMethod;
  status: AccountStatus;
  /** harness 自报的账号标识。不是每家都给,给不出就是 null,❌ 不编一个。 */
  account: string | null;
  /** harness 自己那句原话(为什么没登上 / 为什么判不出)。 */
  message: string | null;
  /** 没装的家登录跑不起来(`hostCli` 解析不出) ⇒ 按钮不给点,并说清先装。 */
  canSignIn: boolean;
};

/**
 * 抽屉里那一行 Account 该长什么样,或者压根不该出现。
 *
 * `null` = 这一家在产品内没有登录动作 ⇒ **整行不渲染**(❌ 不渲染一个灰掉的行:那只会让用户
 * 以为是自己没装好)。
 */
export function resolveAccountRow(
  capabilities: AgentCapabilities | null | undefined,
  auth: AuthStatusModelState | null | undefined,
  installStatus: DependencyStatus | undefined
): AccountRow | null {
  const method = resolveSignInMethod(capabilities);
  if (!method) return null;
  return accountRowOf({ program: undefined, method, legs: null, installStatus }, auth);
}

/**
 * 这一家有哪几个**能在咕咕里登录**的程序(#6335)—— 资源库那一行把它们合成一份(`mergeAccountRows`)。
 *
 * 单程序的家:至多一个,与从前一致。几个程序的家(`programs` 在场):按程序逐个,主程序在前,
 * 各带它服务的腿;哪个程序没声明登录就不算在内。每个程序的「装没装」看它自己那一份。
 */
export type AccountTarget = {
  program: string | undefined;
  method: SignInMethod;
  legs: SessionpageLeg[] | null;
  installStatus: DependencyStatus | undefined;
};

export function resolveAccountTargets(
  agent: Pick<AgentPayload, 'capabilities' | 'programs' | 'status'>
): AccountTarget[] {
  const programs = agent.programs;
  if (!programs || programs.length < 2) {
    const method = resolveSignInMethod(agent.capabilities);
    return method ? [{ program: undefined, method, legs: null, installStatus: agent.status }] : [];
  }
  return programs.flatMap((entry, index) => {
    const program = index === 0 ? undefined : entry.dependencyId;
    const method = resolveSignInMethod(agent.capabilities, program);
    return method ? [{ program, method, legs: entry.legs, installStatus: entry.status }] : [];
  });
}

export function accountRowOf(
  target: AccountTarget,
  auth: AuthStatusModelState | null | undefined
): AccountRow {
  const { program, method, legs } = target;
  const base = { ...(program === undefined ? {} : { program }), legs, method };
  const canSignIn = target.installStatus === 'available';
  const status = auth?.status;
  if (!status) return { ...base, status: 'checking', account: null, message: null, canSignIn };
  switch (status.kind) {
    case 'authenticated':
      return { ...base, status: 'signed-in', account: status.account ?? null, message: null, canSignIn };
    case 'unauthenticated':
      return {
        ...base,
        // #6264 凭据还在、真用时被拒了:「登录已失效」,❌ 与「没登录过」说成一回事。
        status: status.reason === 'expired' ? 'expired' : 'signed-out',
        account: null,
        message: status.message ?? null,
        canSignIn,
      };
    case 'unknown':
      return { ...base, status: 'unknown', account: null, message: status.message ?? null, canSignIn };
  }
}

/**
 * 资源库「账号」那**一行**(#6335:owner 定 —— 一家一行、一颗按钮,❌ 每个程序一行)。
 *
 * 合并规则(各程序的读数 → 一份):
 *  · 任何一个还没读到 ⇒ `checking`(❌ 拿半份读数先下结论);
 *  · 有没登的:别的都登了 ⇒ `partial`(「还差一步」),一个都没登 ⇒ `signed-out`;
 *  · 没有没登的、但有判不出的 ⇒ `unknown`(❌ 把判不出当成登了);
 *  · 全登了 ⇒ `signed-in`。
 * 顺序有讲究:「明确没登」比「判不出」更可行动 —— 有一个明确没登,按钮就该叫人去登。
 *
 * `steps` = 点一下依次要跑的登录:还没登上的那几个(没登的 + 判不出的,按声明顺序);全都登了就
 * 全部重登(「重新登录」)。按钮能不能点看**要跑的那几个**是不是都装好了。
 * 单程序的家:结果与 `resolveAccountRow` 逐字段一致,只多一个 `steps`(就是它自己)。
 *
 * 几个程序时各程序自己的原话(`message`)不往上带:那些话按程序说(「钥匙串里没有 agy 的…」),
 * 放在合并后的一行里是用户看不懂的内部词;说明文字由界面按合并状态自己给。
 */
export type MergedAccountRow = {
  status: MergedAccountStatus;
  account: string | null;
  message: string | null;
  canSignIn: boolean;
  /** 要跑的那几步里第一个没装好的 —— 界面据此说「先装」(协议登录与命令行登录说法不同)。 */
  blockedBy: AccountRow | null;
  /** 还没登上的那几个服务哪些腿(`partial` 时界面据此说「编程模式还要再登录一次」)。 */
  pendingLegs: SessionpageLeg[];
  steps: AccountRow[];
};

export function mergeAccountRows(rows: AccountRow[]): MergedAccountRow | null {
  if (rows.length === 0) return null;
  const single = rows.length === 1 ? rows[0]! : null;
  const signedIn = rows.filter((row) => row.status === 'signed-in');
  // 「登录已失效」(#6264)也是没登上:要跑它、按钮叫人去登;全是失效的那种才说「已失效」。
  const signedOut = rows.filter((row) => row.status === 'signed-out' || row.status === 'expired');
  const unknown = rows.filter((row) => row.status === 'unknown');
  const status: MergedAccountStatus = rows.some((row) => row.status === 'checking')
    ? 'checking'
    : signedOut.length > 0
      ? signedIn.length > 0
        ? 'partial'
        : signedOut.every((row) => row.status === 'expired')
          ? 'expired'
          : 'signed-out'
      : unknown.length > 0
        ? 'unknown'
        : 'signed-in';
  const pending = rows.filter((row) => row.status !== 'signed-in');
  const steps = status === 'signed-in' || pending.length === 0 ? rows : pending;
  const blockedBy = steps.find((row) => !row.canSignIn) ?? null;
  return {
    status,
    account: single?.account ?? null,
    message: single?.message ?? null,
    canSignIn: blockedBy === null,
    blockedBy,
    pendingLegs: status === 'partial' ? [...new Set(pending.flatMap((row) => row.legs ?? []))] : [],
    steps,
  };
}
