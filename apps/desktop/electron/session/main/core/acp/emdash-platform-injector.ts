// @@@2503 平台额度注入的钩子点 —— 与 emdash-mcp-injector 同一个模式:会话页后端这棵树拥有**钩子点**,
// 咕咕宿主拥有**钩子返回什么**(它要签中转令牌、读会话的 composer 选择、认识引擎注入契约,这些
// 会话页后端一样都 import 不到,两边是分开打包的)。
//
// 没装钩子 → 什么都不注入,ACP 会话行为与从前逐字节相同。
//
// Claude 的适配器也按 conversation 独占；它的凭据走会话级 `_meta`。Codex/OpenCode 使用进程级
// 配置，平台凭据进入 main→worker 的内部 spawn 信封。

import type { AcpPlatformInjection } from '@gugu/session-core/acp';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { EmdashSessionStartInfo } from './emdash-mcp-injector';

/**
 * 这条会话的平台注入信封,或 null(不走平台额度)。
 *
 * 三种送达方式都由宿主按引擎注入契约选择;公开 renderer ACP 合约不包含后两种分支。
 *
 * - `session-meta`:凭据按**会话**寻址(Claude 的 ACP session/new | session/load 载体)。
 * - `adapter-spawn`:codex 那份带 provider 声明的载荷,适配器拿它重建 codex 的 config。
 * - `adapter-env`:凭据与模型钉扎**整份**是环境变量(qwen / kimi / copilot 那一族:没有 argv、
 *   没有配置文件)。走能力注入那条腿已有的 `capabilitySpawnEnv` —— 它最后叠进适配器进程环境,
 *   这条会话的 adapter 进程由 runtime 按 conversation id 独占。
 *   ❌ 别为它另开一条 spawn 通道:第二条通道 = 两处各自决定叠放顺序,而顺序错了是静默的。
 */
export type EmdashPlatformInjection =
  | {
      kind: 'session-meta';
      platformAccessSessionId: string;
      sessionMeta: Record<string, unknown>;
      /** Model-only env for the private Claude adapter process; credentials stay session-scoped. */
      adapterEnv?: Record<string, string>;
      /** The platform model this start pins (canonical id), when the resolver named one. */
      model?: string;
    }
  | { kind: 'adapter-spawn'; platformAccessSessionId: string; platform: AcpPlatformInjection }
  | {
      kind: 'adapter-env';
      platformAccessSessionId: string;
      spawnEnv: Record<string, string>;
      /**
       * argv the dialect materializer produced for the adapter process, which in this envelope is
       * the harness itself (copilot's startup `--effort`, #6218). Absent when there is none.
       */
      spawnArgs?: string[];
      /** The platform model this start pins (canonical id). */
      model: string;
    };

/**
 * 可能抛(fail-loud)。抛出 = 这条会话选了平台模型但签不出来/接不上线,那就**不能开**:
 * 静默降级去跑用户自己的 Key,而 composer 上写着咕咕的模型,正是这套设计要杜绝的失败。
 */
export type EmdashPlatformInjector = (
  info: EmdashSessionStartInfo
) => Promise<EmdashPlatformInjection | null>;

/**
 * 结清这条会话握着的平台令牌;`null` = 承载它们的 ACP 运行时整个没了,把这个界面上的全部结清。
 *
 * 为什么必须有这一面:令牌被签发时在网关上预留了额度,不撤销就一直占着窗口,而且这一侧还挂着一个
 * 续期定时器 —— 它会把「一个 TTL 之后自愈的泄漏」续成永久泄漏(会话永远没到期、永远进不了结算巡检)。
 * 同一次调用还负责删掉那份 0600 settings 文档:文档里有中转令牌,会话没了就不该继续躺在磁盘上。
 */
export type EmdashPlatformRelease = (
  sessionId: string | null,
  expectedAccessSessionId?: string,
  intent?: 'end' | 'restart',
) => Promise<void>;
export type EmdashPlatformCheckpoint = (sessionId: string) => Promise<void>;

let injector: EmdashPlatformInjector | null = null;
let release: EmdashPlatformRelease | null = null;
let checkpoint: EmdashPlatformCheckpoint | null = null;
const restartContext = new AsyncLocalStorage<{ sessionId: string; active: boolean }>();
const retiringGenerations = new Map<string, string>();

/** Host-only scope: explicit unrelated stops remain terminal; worker close events carry the retiring generation. */
export async function withEmdashPlatformSessionRestart<T>(
  sessionId: string,
  generation: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (retiringGenerations.has(sessionId)) throw new Error(`platform session ${sessionId} already has a restart owner`);
  const context = { sessionId, active: true };
  retiringGenerations.set(sessionId, generation);
  try {
    return await restartContext.run(context, operation);
  } finally {
    context.active = false;
    retiringGenerations.delete(sessionId);
  }
}

export function emdashPlatformReleaseIntent(
  sessionId: string | null,
  expectedAccessSessionId?: string,
): 'end' | 'restart' {
  const context = restartContext.getStore();
  if (sessionId && ((context?.active && context.sessionId === sessionId)
    || (expectedAccessSessionId !== undefined && retiringGenerations.get(sessionId) === expectedAccessSessionId))) {
    return 'restart';
  }
  return 'end';
}

export function setEmdashPlatformInjector(fn: EmdashPlatformInjector | null): void {
  injector = fn;
}

export function getEmdashPlatformInjector(): EmdashPlatformInjector | null {
  return injector;
}

export function setEmdashPlatformRelease(fn: EmdashPlatformRelease | null): void {
  release = fn;
}

export function setEmdashPlatformCheckpoint(fn: EmdashPlatformCheckpoint | null): void {
  checkpoint = fn;
}

/** Provider stop/error means its current turn is terminal; flush visible usage without ending session. */
export async function checkpointEmdashPlatformSession(sessionId: string): Promise<void> {
  if (!checkpoint) return;
  await checkpoint(sessionId).catch((error: unknown) => {
    console.error('[sessionpage] platform usage checkpoint failed', { sessionId, error });
  });
}

/**
 * 会话结束了 —— 把它的平台令牌结清。
 *
 * ❌ 不让结算失败连累会话结束本身:会话在用户眼里已经停了,这时候抛出去只会让停止操作报错,而令牌
 * 那边还有兜底(续期上限 + 结算巡检)。响亮记一笔,不静默。
 */
export async function releaseEmdashPlatformSession(
  sessionId: string | null,
  expectedAccessSessionId?: string,
): Promise<void> {
  if (!release) return;
  await release(sessionId, expectedAccessSessionId, emdashPlatformReleaseIntent(sessionId, expectedAccessSessionId)).catch((error: unknown) => {
    console.error('[sessionpage] platform token release failed', {
      sessionId,
      expectedAccessSessionId,
      error,
    });
  });
}
