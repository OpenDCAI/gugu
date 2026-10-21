import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export type HarnessLoginRequiredModalArgs = {
  /** 用户刚切过去的那一家。 */
  harnessName: string;
  /** 取消时要回到的那一家；没有上一家（首次选择）时为 null，此时只剩「知道了」。 */
  previousHarnessName: string | null;
  /** 这家自报的登录方式，协议给什么就显示什么；没有就不显示这一行。 */
  authMethods: string[];
  /**
   * 这家声明的**命令行登录**方式 —— 有它这个弹窗才说得出「怎么登」,
   * 「去登录」也才真的通向一个终端。查不到就传 null:那时只剩「知道了」,
   * ❌ 不摆一个点了没反应的「去登录」。
   */
  signInMethod: { id: string; description?: string } | null;
};

export type HarnessLoginRequiredModalResult = { action: 'acknowledge' | 'revert' | 'sign-in' };

type Props = BaseModalProps<HarnessLoginRequiredModalResult> &
  HarnessLoginRequiredModalArgs;

/**
 * 切到一家**强制登录**的 harness 时的那次提示。
 *
 * 产品预期见 spec `harness-vendor-account`。要点：
 *  · 只有两个出口：**去登录**与**取消**（回到切换前那一家）。
 *  · ❌ 不静默停在一个点不动的空界面 —— 那正是这个弹窗要消灭的状态。
 *
 * ⚠️ 「去登录」原先只是**关掉弹窗**。owner 2026-08-26 实测点出的正是这一下：
 *    咕咕说了「需要先登录（Login with Kimi account）」，然后就没有然后了 —— 一句陈述，
 *    没有下一步。所以这里现在做两件从前没做的事：
 *     · 把**怎么登**说出来（插件声明的那条命令行登录方式的原话，见各插件的 auth.ts）；
 *     · 「去登录」接到咕咕**本来就有**的那个登录终端（`agentSignInModal` → `startLogin`），
 *       它跑的是厂商自己的 `<cli> login`。
 *    咕咕仍然不代管厂商的登录：不收集厂商凭据、不转发 OAuth —— 跑的是厂商自家的命令，
 *    设备码/浏览器授权全在厂商那一侧完成。
 *    ⇒ spec 里「去登录 = 关掉弹窗，用户自己去完成」那句与这一下不完全同形，已在交付报告里
 *      单列请 owner 裁决；判据（两个信号各管一半、弹一次、留退路）一条没动。
 *
 * ⚠️ 「强制登录」的判据不是「它提供了登录方式」，而是「给足三方 key 之后还跑不跑得起来」。
 *    照前者判会把 copilot 这种「配了三方 provider 就照跑」的家一起拦下。判据落在插件的
 *    `capabilities.vendorAccount` 上，这里只负责显示。
 */
export function HarnessLoginRequiredModal({
  harnessName,
  previousHarnessName,
  authMethods,
  signInMethod,
  onSuccess,
}: Props) {
  const { translate } = useSessionMessages();

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>{translate('harnessLogin.title', { name: harnessName })}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="flex flex-col gap-3 pt-0">
        <p className="text-sm text-foreground-muted">
          {translate('harnessLogin.description', { name: harnessName })}
        </p>
        {authMethods.length > 0 && (
          <p className="text-sm text-foreground-muted">
            {translate('harnessLogin.methods', { methods: authMethods.join(' / ') })}
          </p>
        )}
        {/*
          怎么登。插件声明里那句原话（「Runs `kimi login`: …」），❌ 不在这里另编一句：
          编出来的会和真正跑起来的那条命令漂移，而这一句的全部价值就在于它就是那条命令。
        */}
        {signInMethod?.description && (
          // 这句话里包着真正要敲的那条 CLI 命令(见上面注释),切不出命令片段就整句走 mono
          // (design.md:mono 唯一的活是「你要输入或安装的东西」—— 2026-09-22 补上)。
          <p className="font-mono text-sm text-foreground-muted">{signInMethod.description}</p>
        )}
      </DialogContentArea>
      <DialogFooter>
        {/*
          没有上一家时不摆「取消」：那个按钮会退回一个不存在的选择。
          ❌ 宁可少一个出口，也不摆一个点了没反应的控件。
        */}
        {previousHarnessName !== null && (
          <Button variant="outline" onClick={() => onSuccess({ action: 'revert' })}>
            {translate('harnessLogin.revert', { name: previousHarnessName })}
          </Button>
        )}
        {/*
          有命令行登录方式才摆「去登录」—— 它真的会打开登录终端。查不到时退回「知道了」，
          ❌ 不摆一个点了只会关窗、却写着「去登录」的按钮。
        */}
        {signInMethod ? (
          <Button onClick={() => onSuccess({ action: 'sign-in' })}>
            {translate('harnessLogin.signIn')}
          </Button>
        ) : (
          <Button onClick={() => onSuccess({ action: 'acknowledge' })}>
            {translate('harnessLogin.acknowledge')}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
