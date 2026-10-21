import type { AgentPayload, Installation, InstallMethod } from '@shared/core/agents/agent-payload';

/**
 * 点「更新」会跑什么。
 *
 * 这里的顺序必须和主进程 `resolveUpdatePlan` 一致 —— 界面说一套、按钮跑另一套,正是 #4271
 * 那个「点了更新、版本不变、无报错」死循环的成因之一。
 *
 * - 与二进制**实际安装方式**对上、且归咕咕管的那条 install option 才有更新动作。
 * - 对不上(来源 unknown / 别人装的 / 策略是 none):没有可执行的更新动作,❌ 不给一个
 *   点了什么都不发生的按钮。
 */
export type UpdateAction = {
  kind: 'package-manager';
  method: InstallMethod;
  registry: string | undefined;
  command: string;
};

export function resolveUpdateAction(
  agentPayload: AgentPayload | undefined,
  installation: Installation | undefined,
  /** 用户选的下载源。与他选了哪一份副本正交 —— 钉住某一份的人照样要能指定从哪个镜像取。 */
  registry: string | undefined,
  _agentId: string,
): UpdateAction | null {
  if (!installation?.updateAvailable) return null;
  const updates = agentPayload?.capabilities.hostDependency.updates;
  const strategyKind = updates?.kind === 'supported' ? updates.update.kind : 'none';
  if (strategyKind === 'none') return null;

  const provKind = installation.provenance.kind;
  const usedMethod =
    provKind !== 'manual' && provKind !== 'version-manager' && provKind !== 'unknown'
      ? (provKind as InstallMethod)
      : null;

  const installOption =
    usedMethod && installation.manageable
      ? agentPayload?.installOptions.find(
          (o) => (o.method === usedMethod || o.replaces?.includes(usedMethod)) && (registry === undefined || o.registry === registry),
        )
      : undefined;
  const optionCommand = installOption?.updateCommand ?? installOption?.command ?? null;

  if (optionCommand && usedMethod) {
    return { kind: 'package-manager', method: installOption!.method, registry, command: optionCommand };
  }

  return null;
}

/**
 * 点「更新」到底跑什么(#6157)。
 *
 * 面板上只有三个按钮(spec),「更新」这一个词后面有两种动作:
 * - 咕咕自己那份、而且真解析得出一条更新命令 → 原地升级;
 * - 机器上本来就有的那份(或解析不出更新命令)→ 咕咕**装一份最新的并切过去**,此后由咕咕管。
 *   spec 明写的就是这一条。❌ 不再像从前那样把更新入口整个藏掉、只留一句「这一份不是咕咕装的,
 *   咕咕不会动它」—— 那句话说完没有下一步,而用户要的正是「让咕咕来管」。
 * - 这一家根本没有托管安装 → null。❌ 不给一个点了必然失败的按钮(#6098)。
 */
export function resolveManagedUpdate(input: {
  /** `resolveUpdateAction` 的结果:归咕咕管、且有一条真能跑的更新命令时才非 null。 */
  updateAction: UpdateAction | null;
  /** 这一家的托管安装选项(已按用户选的下载源筛过);没有就是这儿装不了。 */
  managedInstall: { method: InstallMethod; registry?: string } | undefined;
  /** 用户在「高级」里手动指定的下载源;没指定就是 undefined = 自动(主进程按测速选源)。 */
  registry: string | undefined;
}): { kind: 'update' | 'install'; method: InstallMethod; registry: string | undefined } | null {
  if (input.updateAction) {
    return {
      kind: 'update',
      method: input.updateAction.method,
      registry: input.updateAction.registry,
    };
  }
  if (!input.managedInstall) return null;
  return { kind: 'install', method: input.managedInstall.method, registry: input.registry };
}
