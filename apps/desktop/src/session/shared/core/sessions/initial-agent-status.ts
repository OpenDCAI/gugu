import type { AgentStatus, AgentStatusDetail } from '@shared/core/agents/agentEvents';
import type { SessionOrigin, InitialQueuePrompt, SessionRuntime } from './sessions';

/**
 * 创建一条会话时,关于「第一轮」我们手上有的东西:它是怎么来的(动词),以及首轮的投递载荷。
 * ❌ 不是两套判据 —— 下面两个函数是这件事的**唯一**实现,持久化的行与 renderer 的乐观对象
 * 都读它,两端不得各判一次。
 */
export type SessionCreationFacts = {
  /**
   * 分叉与导入**必须**显式说;新建在载荷已经带着第一句话时可以不写(见 firstUtteranceOf)。
   */
  origin?: SessionOrigin;
  initialPrompt?: string;
  initialQueue?: InitialQueuePrompt[];
};

/**
 * 这条会话的第一轮内容是哪一句(spec session-resume)。一条规则,两种写法:
 * - 显式声明了 `origin.firstUtterance` ⇒ 就是它(首轮走普通消息投递时,载荷里一个字都没有);
 * - 没声明但载荷带着 ⇒ 载荷就是它,不必把同一句话写两遍 —— 写两遍只会等来两份不一致;
 * - 都没有 ⇒ `undefined`,由调用方 fail loud(不带首轮的会话不该被造出来)。
 *
 * ❌ 只用「载荷非空 ⇒ 一定有首轮」这一个方向。反过来推(载荷空 ⇒ 没有首轮)是错的,
 * 那正是 #3684 把一条正在跑的会话画成 idle 的成因。
 */
export function firstUtteranceOf(facts: SessionCreationFacts): string | undefined {
  if (facts.origin && facts.origin.kind !== 'create') return undefined;
  const declared =
    facts.origin?.kind === 'create' ? facts.origin.firstUtterance.trim() || undefined : undefined;
  const payload =
    facts.initialPrompt?.trim() ||
    facts.initialQueue?.map((prompt) => prompt.text.trim() || prompt.files?.map(file => file.name).join(', ')).find(Boolean);
  return declared ?? payload;
}

/** 判断一条会话有没有状态源所需的两个事实:它跑在哪条腿上,以及这一家的 hooks descriptor 声明了什么。 */
export type SessionStatusSource = { runtime: SessionRuntime; hooksKind: string };

/**
 * 这条会话有没有状态源(#6206)。终端腿「这一轮在不在跑」的知识只来自 harness 打回的 hook 边沿;
 * 这一家声明 `hooks.kind === 'none'` 时一条都不会来 ⇒ 没有状态源。ACP 腿的状态走协议更新,恒有。
 * 这是由 descriptor 推出的**正交能力事实**,不是活动轴的第五态:没有状态源的会话 `agent_status` 恒为 `null`,
 * 宿主不写派生活动,渲染层显示「状态不可用」。宿主与渲染层都经这一个函数判,❌ 各自再推一遍。
 */
export function hasStatusSource({ runtime, hooksKind }: SessionStatusSource): boolean {
  return runtime !== 'pty' || hooksKind !== 'none';
}

/**
 * 一条会话出生时的状态,由**它是怎么来的**决定(spec session-resume):
 * - 新建恒带首轮 ⇒ 一出生就在干活。❌ 不再有「这次创建带不带活」的开关。
 * - 分叉、导入与常驻(`resident`,等主人第一条消息的 agent)都不是新建:没人在等它回答,出生即 idle。
 * - 没有状态源的会话(#6206)不陈述任何一态 ⇒ `null`:「在干活」「空闲」对它都是没有证据的话。
 */
export function initialAgentStatus(
  facts: SessionCreationFacts,
  source: SessionStatusSource,
): AgentStatus | null {
  if (!hasStatusSource(source)) return null;
  return (facts.origin?.kind ?? 'create') === 'create' ? 'working' : 'idle';
}

/**
 * 出生状态的附属态(#6448),与基础态同一笔落库:新建的首轮就是一轮在飞(`running`),分叉 / 导入还没跑过(`plain`)。
 * ❌ 留空 —— 首轮的 start 不改基础态(出生就是 working),读数不变就不会再写,附属态会一直空到这一轮结束。
 */
export function initialAgentStatusDetail(status: AgentStatus | null): AgentStatusDetail | null {
  if (status === 'working') return 'running';
  if (status === 'idle') return 'plain';
  return null;
}
