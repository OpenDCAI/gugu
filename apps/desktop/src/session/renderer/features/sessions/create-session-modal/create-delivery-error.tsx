import type { SessionFailure } from '@renderer/features/sessions/stores/session-failure';
import { describeSessionFailure } from '@renderer/features/sessions/stores/session-failure-message';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/**
 * 一轮没送出去时,把原因说给用户听。
 *
 * @@@5173 三个创建面(会话页 / 项目首页 / 创建弹窗)调的是同一个 useCreateSessionCallback,但从前
 * 只有会话页渲染它的 deliveryError,另外两面把那个字段直接解构丢掉 —— 于是**同一次失败**在这一面
 * 出提示、在那一面什么都不显示。共用这个组件是为了让「谁渲染」不再是各自的选择。
 *
 * 投递失败与「不能提交」是两件事:未送出的正文与附件都还留在 composer 里,重试要按得下去,
 * 所以它只陈述原因、❌ 不参与 canSend(#4325 要求③:fail loud,❌ 静默丢)。
 *
 * gugu #2525: 颜色走 --em-* arbitrary value,不用 text-foreground-destructive 这类 color key ——
 * session-composer-styles.ts 里实测记过:嵌进 gugu 的会话页子树里 --color-* 家族解析为空,
 * Tailwind v4 对未定义 color key 直接不出规则 → 报错文案会**无声**变成普通正文色。
 * 这是一条 fail-loud 提示,它的可见性本身就是功能的一部分,不能赌。
 */
export function CreateDeliveryError({ failure }: { failure: SessionFailure | null }) {
  const { translate } = useSessionMessages();
  if (!failure) return null;
  return (
    <p
      role="alert"
      data-testid="create-delivery-error"
      className="border-t border-border px-4 py-2 text-xs text-[var(--em-foreground-destructive)]"
    >
      {describeSessionFailure(failure, translate)}
    </p>
  );
}
