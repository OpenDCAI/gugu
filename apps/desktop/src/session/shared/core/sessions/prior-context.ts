/**
 * 一条会话**有没有前文** —— 也就是「它是不是一张白纸」的反面(spec session-graph)。
 *
 * 前文有三种来源,与创建的三个动词一一对应,**同权**:
 * - 新建:首轮就是它的前文,哪怕这一句还没落进 transcript(`firstUtterance`);
 * - 分叉:继承来源那条 provider 会话(`forkFromProviderSessionId`,认领首启后是自己的 `sessionId`);
 * - 导入:出生即带着要 resume 的 provider 会话(同样落在 `sessionId` 上)。
 *
 * ⚠️ ❌ 不许拿 `firstUtterance` 单独当这个判据。它只属于**新建**那一支 —— 分叉与导入按设计
 * 不写它(见 `firstUtteranceOf`:非 create 的 origin 一律返回 undefined),于是「没有首轮」
 * 在它们身上意味着「前文是继承来的」,而不是「还没开始」。两者读起来一模一样,后果却相反:
 * 一条 fork 出来的会话会被画成尚未开始的创建页(#5425 —— fork 的侧边聊天上实测)。
 *
 * 这个函数是这件事的**唯一**判据:持久化的行、renderer 的会话对象、运行时分叉的临时视图
 * 都读它,❌ 不得各判一次。运行时分叉(侧边聊天)按构造带着来源的 provider 会话 id,
 * 所以它把那个 id 填进 `forkFromProviderSessionId` 来回答同一个问题,而不是另开一条分支。
 */
/**
 * 三格**都必须写出来**(值可以是 undefined,键不行)。
 *
 * ⚠️ 全可选的入参会让**任何**对象都通过类型检查,而这三样并不总在同一层:落库的行把
 * `firstUtterance` 与 `forkFromProviderSessionId` 收在 `config` 里,顶层只有 `sessionId`。
 * 那种形状要是能直接递进来,它会静静地答「没有前文」——正是本判据要消灭的那次误读,
 * 而编译器一声不响。键设为必填,调用方就必须先说清每一格从哪来。
 */
export type SessionPriorContextFacts = {
  /** 新建时记下的首轮(落库的行在 `config.firstUtterance`)。 */
  firstUtterance: string | undefined;
  /** 已经认领的 provider 会话 id。 */
  providerSessionId: string | undefined;
  /** 分叉还没认领首启时,要分叉的来源 provider 会话(落库的行在 `config` 里)。 */
  forkFromProviderSessionId: string | undefined;
};

export function sessionHasPriorContext(facts: SessionPriorContextFacts): boolean {
  return Boolean(facts.firstUtterance || facts.providerSessionId || facts.forkFromProviderSessionId);
}
