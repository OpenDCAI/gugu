import type { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AutomationRunTriggerKind, RunError } from '@shared/core/automations/automation-run';

type Translate = ReturnType<typeof useSessionMessages>['translate'];
type ErrorFormatter = (translate: Translate, msg?: string) => string;

// @@@i18next-cli — formatter 形参不能命名为 t:官方 extractor 把任何 t('...') 当成待抽取的
// key,会把本域 catalog 灌进 apps/desktop/src/i18n/locales/**,让 pnpm i18n:check 变红。
// @@@stable code → shell — 只有已知的 step/code 组合映射成本地化外壳;分支名、超时毫秒数、
// remote 名和未识别的 code/message 一律作为原始 detail 插值或直出。
const RUN_ERROR_DISPLAY: Record<RunError['step'], Record<string, ErrorFormatter>> = {
  queue: {
    deadline_exceeded: (translate) => translate('automations.errorQueueDeadline'),
    no_project: (translate) => translate('automations.errorQueueNoProject'),
    previous_running: (translate) => translate('automations.errorQueuePreviousRunning'),
    manually_stopped: (translate) => translate('automations.errorQueueManuallyStopped'),
    disabled: (translate) => translate('automations.errorQueueDisabled'),
    no_actions_configured: (translate) => translate('automations.errorQueueNoActions'),
  },
  create_session: {
    interrupted_by_restart: (translate) => translate('automations.errorInterruptedByRestart'),
    project_not_found: (translate) => translate('automations.errorProjectNotFound'),
    worktree_setup_failed: (translate, branch) =>
      branch
        ? translate('automations.worktreeSetupFailed', { branch })
        : translate('automations.errorWorktreeSetup'),
    branch_create_failed: (translate, branch) =>
      branch ? translate('automations.branchCreateFailed', { branch }) : translate('automations.errorBranchCreate'),
    branch_not_found: (translate, branch) =>
      branch ? translate('automations.branchNotFound', { branch }) : translate('automations.errorBranchNotFound'),
    initial_commit_required: (translate, branch) =>
      branch ? translate('automations.branchNoCommits', { branch }) : translate('automations.errorBranchNoCommits'),
    provision_timeout: (translate, ms) =>
      ms ? translate('automations.setupTimedOut', { ms }) : translate('automations.errorSetupTimedOut'),
    pr_fetch_failed: (translate, remote) =>
      remote
        ? translate('automations.pullRequestFetchFailed', { remote })
        : translate('automations.errorPullRequestFetch'),
  },
  launch_session: {
    provision_failed: (translate, msg) => msg ?? translate('automations.workspaceSetupFailed'),
    interrupted_by_restart: (translate) => translate('automations.errorInterruptedByRestart'),
  },
  start_agent: {
    interrupted_by_restart: (translate) => translate('automations.errorInterruptedByRestart'),
    failed: (translate, msg) => msg ?? translate('automations.conversationStartFailed'),
  },
  // #7221 agent 给自己排的那一类:把交代送回它的会话。
  deliver: {
    agent_gone: (translate) => translate('automations.errorAgentGone'),
    // 送不到的具体原因在主进程日志里(deliverToAgent.ts);文案只给下一步。
    delivery_failed: (translate) => translate('automations.errorDeliveryFailed'),
  },
};

export function formatRunError(translate: Translate, error: RunError | null): string {
  if (!error) return translate('automations.unknownError');
  const stepMap = RUN_ERROR_DISPLAY[error.step];
  if (!stepMap) return error.message ?? `${error.step}:${error.code}`;
  const formatter = stepMap[error.code];
  if (formatter) return formatter(translate, error.message);
  return error.message ?? `${error.step}:${error.code}`;
}

export function formatRunTriggerKindLabel(
  translate: Translate,
  kind: AutomationRunTriggerKind
): string {
  switch (kind) {
    case 'cron':
      return translate('automations.triggerCron');
    case 'manual':
      return translate('automations.triggerManual');
  }
}

const FORM_ERROR_MESSAGE_KEYS: Record<string, Parameters<Translate>[0]> = {
  name_required: 'automations.formNameRequired',
  name_too_long: 'automations.formNameTooLong',
  actions_required: 'automations.formActionsRequired',
  automation_not_found: 'automations.formNotFound',
  automation_run_in_flight: 'automations.formRunInFlight',
  automation_run_already_queued: 'automations.formRunAlreadyQueued',
  automation_run_not_found: 'automations.formRunNotFound',
  cron_invalid: 'automations.formCronInvalid',
  schedule_time_passed: 'automations.formScheduleTimePassed',
  deadline_policy_invalid: 'automations.formDeadlinePolicyInvalid',
  deadline_ms_invalid: 'automations.formDeadlineMsInvalid',
  run_update_failed: 'automations.formRunUpdateFailed',
  task_create_prompt_empty: 'automations.formPromptEmpty',
};

export function formatAutomationError(translate: Translate, error: unknown): string {
  const msg = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  if (!msg) return translate('automations.genericError');
  // @@@raw detail — 未登记的校验码原样透出,不改写。
  const key = FORM_ERROR_MESSAGE_KEYS[msg];
  return key ? translate(key) : msg;
}
