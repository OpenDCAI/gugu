/**
 * 任务失败的**领域**表示 —— 与任何翻译目录无关。
 *
 * store 只记「发生了哪一种业务失败，以及它自带的原始字段」；它不认识 catalog key、不持有译文、
 * 也不持有 translator。成句发生在渲染边界（`sessionErrorMessage`），所以：
 *   · 切换语言时一条**已经显示出来的**错误会跟着变，且不需要重跑任何创建/准备流程；
 *   · 分支名、远程名、PR 号、setup step 名、底层 message 这些原始数据逐字保存、永不翻译。
 *
 * ❌ 不要在这里 import localization：一旦 store 合同引用 catalog key，语言就又变成业务状态的一部分。
 */
import type { CreateSessionError } from '@shared/core/sessions/create-session';

/** 已知 git fetch 失败。 */
export type GitFetchFailure =
  | { kind: 'no-remote' }
  | { kind: 'github-auth-failed' }
  | { kind: 'git-auth-failed' }
  | { kind: 'network-error' }
  | { kind: 'remote-not-found' }
  /** 未归类的 git 失败：底层 message 逐字保留，渲染时原样带出，永不被通用译文替换。 */
  | { kind: 'unexpected'; detail: string };

export type SessionFailure =
  | { kind: 'project-not-found' }
  /**
   * 引擎此刻起不来,任务因此没有被创建。`reason` 决定指路,不是同一句话的两种说法:
   * `updating` 让用户稍后重试,`missing` 让用户去装。`detail` 是解析器诊断原文,逐字保留。
   */
  | {
      kind: 'harness-unavailable';
      reason: 'updating' | 'missing';
      providerId: string;
      harnessName: string;
      detail: string;
    }
  | { kind: 'provision-timeout'; timeoutMs: number }
  | { kind: 'workspace-no-intent' }
  | { kind: 'workspace-missing' }
  | { kind: 'setup-step-failed'; stepKind: string; stepErrorType: string; detail?: string }
  /** 未知失败：底层原始诊断，逐字保留、永不翻译。 */
  | { kind: 'raw'; detail: string };

/**
 * @@@5173 建任务失败时抛给调用方的**类型化**错误。
 *
 * message 保持原样(`createSession failed: <type>`)——那是面向开发者的稳定串;`failure` 让 UI 拿得到
 * 领域语义,不必去解析 message。此前 composer 的 catch 直接把 message 铺给用户,于是用户看到的是
 * `createSession failed: harness-unavailable` 这种诊断串,而 store 里那份本地化文案没人读。
 *
 * ⚠️ 它住在这个**叶子**文件里是有原因的,❌ 别挪回 project-sessions-store.ts:composer 那个 hook 要 import 它,
 * 而 project-sessions-store 会把 app-state → ProjectManagerStore 这一整片拽进 hook 的模块图 ——
 * 实测 `use-create-session-callback.test.ts` 因此在 import 阶段就炸(`No "events" export ... mock`),
 * 一条用例都跑不到。本文件除类型外不 import 任何东西,这条约束本身就是它的价值。
 */
export class SessionCreationFailedError extends Error {
  constructor(readonly errorType: CreateSessionError['type'], readonly failure: SessionFailure) {
    super(`createSession failed: ${errorType}`);
    this.name = 'SessionCreationFailedError';
  }
}
