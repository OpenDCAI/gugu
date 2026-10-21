import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { usePlatformModelCatalog } from '@renderer/features/sessions/session-config/platform-model-catalog';
import { subscriptionKey, useSubscriptionPlan } from '@renderer/features/settings/subscriptions/subscription-queries';
import { planLabel } from '@renderer/features/settings/subscriptions/subscription-view';
import { useAgentAuthStatuses } from '@renderer/lib/stores/use-agent-auth-status';
import { forceRefreshHarnessModelCatalog } from '@renderer/lib/stores/use-harness-model-catalog';
import { harnessModelCredentialKey } from '@renderer/lib/stores/use-harness-model-credential';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { sessionViewOfLeg, type SessionpageLeg } from '@shared/core/sessions/sessions';
import {
  accountRowOf,
  mergeAccountRows,
  resolveAccountTargets,
  type AccountTarget,
  type MergedAccountRow,
} from './agent-account';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

function statusLabel(translate: Translate, row: MergedAccountRow): string {
  switch (row.status) {
    case 'checking':
      return translate('agentsPage.checking');
    case 'signed-in':
      return row.account
        ? translate('agentsPage.accountSignedInAs', { account: row.account })
        : translate('agentsPage.accountSignedIn');
    case 'partial':
      return translate('agentsPage.accountPartial');
    case 'signed-out':
      return translate('agentsPage.accountSignedOut');
    case 'expired':
      return translate('agentsPage.accountExpired');
    case 'unknown':
      return translate('agentsPage.accountUnknown');
  }
}

/**
 * 还差的那几条腿用 composer 里「模式」控件的原词说(通用 / 编程)——❌ 不用「程序 / 腿 / agy」这类
 * 界面上没有的词。
 */
function modesText(translate: Translate, legs: SessionpageLeg[]): string {
  return [...new Set(legs.map((leg) => sessionViewOfLeg(leg)))]
    .map((view) =>
      translate('agentsPage.accountModeRow', {
        mode: translate(view === 'general' ? 'taskConfig.sessionViewGeneral' : 'taskConfig.sessionViewCode'),
      })
    )
    .join(' / ');
}

/**
 * 说清「为什么是这个读数」。
 *
 * `unknown` 尤其需要:它多半不是用户的错(CLI 解析不出、配置根被挪走、harness 自己答不上来)。
 * 只画两个字「未知」等于把一个仪器故障说成用户状态。harness 自报的原话优先,没有原话时兜一句
 * 「读不出」——❌ 不静默。`partial` 说清哪种模式还要再登一次、点一下会发生什么。
 */
function hintText(translate: Translate, row: MergedAccountRow): string | null {
  if (row.blockedBy) {
    // 协议登录(acp-authenticate)不跑 CLI:登录是咕咕对装好的那个程序发的一句协议请求(#6335)。
    return translate(
      row.blockedBy.method.kind === 'acp-authenticate'
        ? 'agentsPage.accountNeedsInstallProtocol'
        : 'agentsPage.accountNeedsInstall'
    );
  }
  if (row.status === 'partial' && row.pendingLegs.length > 0) {
    return translate('agentsPage.accountPartialHint', { modes: modesText(translate, row.pendingLegs) });
  }
  if (row.status === 'expired') return translate('agentsPage.accountExpiredHint');
  if (row.message) return row.message;
  if (row.status === 'unknown') return translate('agentsPage.accountUnknownHint');
  return null;
}

/**
 * 抽屉里的那一行「账号」(#6100)。
 *
 * 只对**真能在产品内登录**的家渲染(声明了 cli-login 或 acp-authenticate)——判据在 `agent-account.ts`,
 * 与 composer、会话页共用同一份。
 *
 * 一家分成几个各自登录的程序时(#6335:Antigravity 通用模式跑 `agy_acp_server`、编程模式跑 `agy`,
 * 两者凭据不共享),界面上仍是**一行、一颗按钮**(owner 定):读数合成一份(全登了 / 还差一步 / 未登录 /
 * 判不出),点一下把还没登的那几个依次登完。单程序的家长相与从前逐像素一致。
 *
 * ⚠️ 这一格是**内容**:容器形态(右侧抽屉 / 居中模态)由 #6088 定,❌ 别在这里动容器。
 */
export function AgentAccountSection({ agent }: { agent: AgentPayload }) {
  const targets = resolveAccountTargets(agent);
  if (targets.length === 0) return null;
  return <AgentAccountRow agent={agent} targets={targets} />;
}

function AgentAccountRow({ agent, targets }: { agent: AgentPayload; targets: AccountTarget[] }) {
  const { translate } = useSessionMessages();
  // #6264 资源库看的是别的机器:读数与登录都在**那台机器上**(同一组动词,rpc 送到那台机器),行还是这一行。
  const host = useLibraryHost();
  const remote = host.remote;
  const local = useAgentAuthStatuses(
    agent.id,
    targets.map((target) => target.program),
    { machine: remote?.deviceId ?? null }
  );
  const refreshAuth = local.refresh;
  const queryClient = useQueryClient();
  const showSignIn = useShowModal('agentSignInModal');
  const row = mergeAccountRows(targets.map((target, index) => accountRowOf(target, local.auths[index])))!;
  // 与新建框同一份目录(问的也是资源库正在看的那台机器)。
  const platform = usePlatformModelCatalog(agent.id, 'acp');
  // 账号下面一行写套餐名:与设置「订阅」页同一份读数(同一把键),❌ 各问各的(product spec)。
  const machine = remote?.deviceId ?? null;
  const plan = planLabel(useSubscriptionPlan(machine, agent.id).data, translate);

  /**
   * 装上 / 卸掉 / 换一份之后重探一次登录态。挂载时那一探若赶在装好之前,读到的是「没这个程序」
   * 那种判不出(`unknown`),而弹窗一直开着就一直停在那 —— 要关掉重开才会翻(#6335 首测实录)。
   * 只在安装读数**变了**时探:首次挂载那一探由 `useAgentAuthStatuses` 自己发,❌ 不重复。
   * 看的是每个程序各自那一份安装读数(只补装了终端那个程序时同样要翻)。
   */
  const installKey = targets.map((target) => target.installStatus ?? '').join('|');
  const lastInstall = useRef(installKey);
  useEffect(() => {
    if (lastInstall.current === installKey) return;
    lastInstall.current = installKey;
    void refreshAuth();
  }, [installKey, refreshAuth]);

  const openSignIn = useCallback(() => {
    if (remote) {
      /** 在那台机器上登:登完 / 关窗都让那台机器上这一家的读数(账号、模型目录)重问一遍。 */
      const refresh = () => {
        void refreshAuth();
        void queryClient.invalidateQueries({ queryKey: ['agents'] });
        void queryClient.invalidateQueries({ queryKey: subscriptionKey(machine, agent.id) });
      };
      const main = row.steps.find((step) => step.program === undefined) ?? row.steps[0];
      const method = main?.method;
      const cliArgs = method?.kind === 'cli-login' ? method.args : [];
      showSignIn({
        providerId: agent.id,
        providerName: agent.name,
        steps: method ? [{ methodId: method.id }] : [],
        remote: {
          deviceId: remote.deviceId,
          deviceLabel: remote.deviceLabel,
          headless: method?.kind === 'cli-login' && !!method.headlessArgs,
          // 只能自己登时,在那台机器终端里要敲的命令:CLI 名取这家的可执行文件名(与那台机器同一个名字)。
          command: [agent.command?.split(/[\\/]/).filter(Boolean).pop() || agent.id, ...cliArgs].join(' '),
        },
        onSuccess: refresh,
        onClose: refresh,
      });
      return;
    }
    /**
     * 登录完**强制**重读三样:这一家的登录态、它的模型目录、它的模型凭据读数。
     *
     * 目录那份带 force —— 主进程的 TTL 对「用户刚刚登完」这件事一无所知,不跳过它的话
     * composer 会继续显示那句「需要先登录」,用户以为没登上又去登一遍(#5605 一族)。
     * 三者用的都是**已有**那几把 react-query key,所以 composer 手上那份当场跟着翻。
     * 成功与关窗都走同一条:登录成没成只有 harness 知道,关窗那一下同样要重问(见 `login-success.ts`)。
     *
     * 只有主程序在这一趟里登过时才强制重探目录:模型目录与凭据是主程序起出来的
     * (`harness-model-catalog` 探的是主程序),伴随程序的登录一个字节都不影响它们。
     */
    const touchesMain = row.steps.some((step) => step.program === undefined);
    const refreshAfterLogin = () => {
      void refreshAuth();
      void queryClient.invalidateQueries({ queryKey: subscriptionKey(machine, agent.id) });
      if (!touchesMain) return;
      void forceRefreshHarnessModelCatalog(queryClient, agent.id);
      void queryClient.invalidateQueries({ queryKey: harnessModelCredentialKey(agent.id) });
    };
    showSignIn({
      providerId: agent.id,
      providerName: agent.name,
      steps: row.steps.map((step) => ({
        methodId: step.method.id,
        ...(step.program === undefined ? {} : { program: step.program }),
        transport: step.method.kind === 'acp-authenticate' ? 'acp-authenticate' : 'terminal',
      })),
      onSuccess: refreshAfterLogin,
      onClose: refreshAfterLogin,
    });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, agent.name, agent.command, queryClient, refreshAuth, row.steps, showSignIn, remote, machine]);

  const hint = row.status === 'signed-out' && platform.models.length > 0
    // 这一家有咕咕提供的模型:不登录也照样能用(资源库体检 10-07:Claude「未登录」而任务照常跑)。
    ? translate('agentsPage.accountOptionalWithGugu')
    : hintText(translate, row);

  /* 一条细线 + 一行:左边「账号」,中间读数,右边按钮。❌ 不再是标签下面再套一个框。 */
  return (
    <div className="flex items-center gap-4 border-t py-4">
      <span className="w-12 shrink-0 text-sm text-foreground-muted">{translate('agentsPage.account')}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={row.status === 'expired' ? 'truncate text-sm text-foreground-warning' : 'truncate text-sm text-foreground'}
          data-testid="agent-account-status"
          data-status={row.status}
        >
          {statusLabel(translate, row)}
        </span>
        {row.status === 'signed-in' && plan && (
          <span className="truncate text-sm text-foreground-muted" data-testid="agent-account-plan">
            {`${translate('subscriptions.payer.subscription')} · ${plan}`}
          </span>
        )}
        {hint && (
          <span className="truncate text-sm text-foreground-muted" title={hint}>
            {hint}
          </span>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={!row.canSignIn}
        onClick={openSignIn}
        data-testid="agent-account-sign-in"
      >
        {translate(
          row.status === 'signed-in' || row.status === 'expired'
            ? 'agentsPage.accountSignInAgain'
            : 'agentsPage.accountSignIn'
        )}
      </Button>
    </div>
  );
}
