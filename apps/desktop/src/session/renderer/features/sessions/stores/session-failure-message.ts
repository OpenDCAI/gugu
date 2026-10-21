import type { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { SessionFailure } from './session-failure';

/**
 * 渲染边界：领域 failure kind → catalog 外壳。
 *
 * store 里存的是业务语义 + 原始字段（见 session-failure.ts），成句只在这里发生，
 * 所以切换语言时一条**已经显示出来的**错误会跟着重新成句，而不需要重跑创建/准备流程。
 * 原始字段（分支名、远程名、PR 号、底层 message）只作为插值穿过外壳，逐字保留。
 *
 * ⚠️ @@@5173 它住在这个**叶子**文件里,❌ 别挪回 session-selectors.ts:那个模块把
 * session-registry / project store / terminal registry 一整片拽进来,而**渲染一行错误提示**
 * 不需要其中任何一个。真正吃亏的是调用方 —— 谁想说出这句话,谁就得先把那片图 mock 掉
 * (实测 new-session-page 的壳整模块 mock 了 session-selectors,组件从它这里拿到的 describeSessionFailure
 * 就是 undefined)。这里除类型外不 import 任何东西。
 */
export type SessionTranslate = ReturnType<typeof useSessionMessages>['translate'];

export function describeSessionFailure(
  failure: SessionFailure,
  translate: SessionTranslate
): string {
  switch (failure.kind) {
    case 'raw':
      return failure.detail;
    case 'project-not-found':
      return translate('taskError.projectNotFound');
    // 两种原因指向相反的方向 —— 正在被替换的等一等就好,真没装的要去装。
    // ❌ 别合成一句「引擎不可用」:那正是本 bug 里把用户支去安装一个已经装着的东西的那句话。
    case 'harness-unavailable':
      return failure.reason === 'updating'
        ? translate('taskError.harnessUpdating', { harnessName: failure.harnessName })
        : translate('taskError.harnessMissing', { harnessName: failure.harnessName });
    case 'provision-timeout':
      return translate('taskError.provisionTimeout', { timeoutMs: failure.timeoutMs });
    case 'workspace-no-intent':
      return translate('taskError.noIntent');
    case 'workspace-missing':
      return translate('taskError.missingWorkspace');
    case 'setup-step-failed':
      return translate('taskError.setupStepFailed', {
        stepKind: failure.stepKind,
        stepErrorType: failure.stepErrorType,
        detail: failure.detail ? `: ${failure.detail}` : '',
      });
  }
}

