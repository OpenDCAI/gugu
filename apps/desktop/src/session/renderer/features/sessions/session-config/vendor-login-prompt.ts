import type { AgentCapabilities } from '@shared/core/agents/agent-payload';
import type { HarnessCatalogState } from '@renderer/lib/stores/use-harness-model-catalog';

/**
 * 要不要给用户那次「先去登录」的提示（spec: harness-vendor-account）。
 *
 * 两个信号缺一不可，各管一半：
 *  · `vendorAccount === 'required'` 是**关于这家 harness 的固定事实**（给足三方 key 也跑不
 *    起来），与用户此刻装了什么无关；
 *  · catalog 的 `auth-required` 是**这位用户此刻的状态**（真起了一次会话、被它拒了）。
 *
 * ❌ 只看后者会误伤。那个 catalog 探针起进程时**不带**咕咕的注入（只有 `buildAgentEnv` 白名单
 *    加插件自己的 spawn env），于是像 copilot 这种「配了三方 provider 就照跑」的家，在平台额度
 *    会话里也会报 `auth-required` —— 用户其实能用，弹窗却拦着他。
 *    copilot 正是这条判据的活例子：它 README 写着「An active Copilot subscription」，
 *    实测只给 `COPILOT_PROVIDER_*`、零 GitHub 凭据照样跑完一轮。
 *
 * ❌ 只看前者会烦人：已经登好的用户每切一次 harness 都要被打断一次。
 *
 * ⚠️ `unverified` 走 false —— 但那是「不知道」，不是「不需要」。谁把一家从 `unverified` 提到
 *    `required`，弹窗自动就有了；反过来把一家从 `required` 改成 `not-required`，得先拿出一次
 *    真跑通的读数（`vendor-account-conformance` 那卷钉着）。
 */
export function shouldPromptVendorLogin(
  capabilities: AgentCapabilities | null | undefined,
  catalogState: Pick<HarnessCatalogState, 'kind'>,
): boolean {
  return capabilities?.vendorAccount?.kind === 'required' && catalogState.kind === 'auth-required';
}

/**
 * 这条腿上「要不要去登录」的**唯一**一份判据(#6335)—— 按**这条腿跑的那个程序**问。
 *
 * 一家的两条腿可以是两个不共享登录的程序(Antigravity:通用模式 `agy_acp_server`、编程模式 `agy`)。
 * 模型目录探针起的是主程序,它的 `auth-required` 说的是**主程序**登没登 —— 拿它去拦编程模式,
 * 就是「聊天面板没登 ⇒ 让你去登终端那个」或「终端那个没登却一声不吭」,两头都错。
 *
 *  · 这条腿由一个声明了自己登录的伴随程序跑(`target.program` 在场)⇒ 只看**那个程序**的读数:
 *    明确读到「没登录」才拦(弹一次提示 + 模型清单里的登录入口),`unknown` / 在途一律不拦 ——
 *    判不出不是没登录。它没有「给了三方 key 也能跑」那种例外要防:API key 模式由它的读数本身判成已登录。
 *  · 否则照旧(主程序的目录读数 + `vendorAccount`,见 `shouldPromptVendorLogin`),逐字节不变。
 */
export type LegLoginGate = {
  /** 切到这一家时弹一次「需要先登录」。 */
  prompt: boolean;
  /** 模型清单里给一条「去登录」的入口。 */
  signIn: boolean;
  /** 提示里列出的登录方式名。 */
  methodNames: string[];
};

export function resolveLegLoginGate(input: {
  capabilities: AgentCapabilities | null | undefined;
  catalogState: HarnessCatalogState;
  target: { program: string | undefined; method: { name: string } } | null;
  /** `target.program` 那个程序的登录读数(`useAgentAuthStatus(providerId, program)`);主程序那一路不读它。 */
  programStatus: { kind: 'authenticated' | 'unauthenticated' | 'unknown' } | null | undefined;
}): LegLoginGate {
  const { capabilities, catalogState, target, programStatus } = input;
  if (target && target.program !== undefined) {
    const signedOut = programStatus?.kind === 'unauthenticated';
    return { prompt: signedOut, signIn: signedOut, methodNames: signedOut ? [target.method.name] : [] };
  }
  const authRequired = catalogState.kind === 'auth-required';
  return {
    prompt: shouldPromptVendorLogin(capabilities, catalogState),
    signIn: authRequired && target !== null,
    methodNames: authRequired ? catalogState.authMethods.map((method) => method.name) : [],
  };
}
