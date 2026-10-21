import type {
  SubscriptionPlanReading,
  SubscriptionUsageReading,
  SubscriptionUsageWindow,
} from '@gugu/session-core/agents/plugins';
import type { SessionMessageValues } from '@renderer/localization/locale-store';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';

type Translate = (key: SessionMessageLookupKey, values?: SessionMessageValues) => string;

/**
 * 「订阅」页一行里的字(product spec)。纯函数:读数 → 要画的字，好钉单测。
 * 套餐名是厂商自己的叫法，原样显示;读不到的格说为什么，❌ 画成 0、❌ 猜。
 */

/** 谁在付钱 + 套餐 —— 行的第一行说明。`hasGuguModels`:这家能走咕咕积分(没登自己的账号时补一句)。 */
export function payerLine(plan: SubscriptionPlanReading, translate: Translate, hasGuguModels: boolean): string {
  switch (plan.payer) {
    case 'subscription': {
      const name = plan.plan ? planName(plan, translate) : undefined;
      return name
        ? `${translate('subscriptions.payer.subscription')} · ${name}`
        : translate('subscriptions.payer.subscription');
    }
    case 'api-key':
      return plan.plan
        ? `${translate('subscriptions.payer.apiKey')} · ${plan.plan}`
        : translate('subscriptions.payer.apiKey');
    case 'custom-endpoint':
      return translate('subscriptions.payer.customEndpoint', { endpoint: plan.endpoint ?? '' }).trim();
    case 'not-signed-in':
      return translate(hasGuguModels ? 'subscriptions.payer.notSignedInGugu' : 'subscriptions.payer.notSignedIn');
    case 'unknown':
      return plan.message
        ? `${translate('subscriptions.payer.unknown')}:${plan.message}`
        : translate('subscriptions.payer.unknown');
  }
}

function planName(plan: SubscriptionPlanReading, translate: Translate): string {
  return plan.tierUnknown ? translate('subscriptions.tierUnknown', { plan: plan.plan ?? '' }) : plan.plan ?? '';
}

/** 资源库「账号」那一行跟在账号后面的套餐名:只在是订阅且读得出名字时(别的付钱方式那一行不说)。 */
export function planLabel(plan: SubscriptionPlanReading | undefined, translate: Translate): string | null {
  return plan?.payer === 'subscription' && plan.plan ? planName(plan, translate) : null;
}

/** 行的附注:接的是哪几家、套餐信息多旧、Pi 那种「扣额外用量」、没登录时去哪里登。 */
export function planNotes(
  plan: SubscriptionPlanReading,
  translate: Translate,
  formatDate: (epochMs: number) => string
): string[] {
  const notes: string[] = [];
  if (plan.via && plan.via.length > 0) notes.push(translate('subscriptions.via', { vendors: plan.via.join(' · ') }));
  if (plan.planAsOf !== undefined) notes.push(translate('subscriptions.planAsOf', { date: formatDate(plan.planAsOf) }));
  if (plan.extraUsage) notes.push(translate('subscriptions.extraUsage'));
  if (plan.payer === 'not-signed-in') notes.push(translate('subscriptions.signInHint'));
  return notes;
}

/** 窗口的名字:按长度不按厂商的位置;厂商分了组就带上组名(原样)。 */
export function windowLabel(window: SubscriptionUsageWindow, translate: Translate): string {
  const span = windowSpan(window, translate);
  return window.group ? `${span} · ${window.group}` : span;
}

function windowSpan(window: SubscriptionUsageWindow, translate: Translate): string {
  if (window.monthly) return translate('subscriptions.window.month');
  const minutes = window.windowMinutes;
  if (minutes === undefined) return translate('subscriptions.window.other');
  if (minutes === 300) return translate('subscriptions.window.fiveHour');
  if (minutes === 10_080) return translate('subscriptions.window.week');
  if (minutes % 1_440 === 0) return translate('subscriptions.window.days', { days: minutes / 1_440 });
  return translate('subscriptions.window.hours', { hours: Math.round((minutes / 60) * 10) / 10 });
}

/** 用了多少:有绝对数(Copilot 的次数)给绝对数，否则给百分比;百分比保留到整数，小于 1 的非零值保留一位。 */
export function usedText(window: SubscriptionUsageWindow, translate: Translate): string {
  if (window.used !== undefined && window.limit !== undefined) {
    return translate('subscriptions.usedCount', { used: window.used, limit: window.limit });
  }
  return translate('subscriptions.used', { percent: formatPercent(window.usedPercent) });
}

export function formatPercent(value: number): string {
  if (value > 0 && value < 1) return value.toFixed(1);
  return String(Math.round(value));
}

/** 读不到的那一句(读到窗口时为 null)。没登录时付钱那行已经说了，这里不再重复 ⇒ null。 */
export function unavailableText(reading: SubscriptionUsageReading, translate: Translate): string | null {
  if (reading.kind === 'windows') return null;
  switch (reading.reason) {
    case 'vendor-console':
      return translate('subscriptions.unavailable.vendorConsole');
    case 'not-reported':
      return translate('subscriptions.unavailable.notReported');
    case 'not-signed-in':
      return null;
    case 'custom-endpoint':
      return translate('subscriptions.unavailable.customEndpoint');
    case 'other-login':
      return translate('subscriptions.unavailable.otherLogin');
    case 'not-read-yet':
      return translate('subscriptions.unavailable.notReadYet');
    case 'error':
      return translate('subscriptions.unavailable.error', { message: reading.message ?? '' });
  }
}

/** 已用到这个程度就用警示色画条(快用完了)。 */
export const NEARLY_USED_PERCENT = 90;


/** An API connection has no subscription quota to query. */
export function quotaReading(plan: SubscriptionPlanReading | undefined, reading: SubscriptionUsageReading | undefined): SubscriptionUsageReading | undefined {
  if (reading?.kind !== 'unavailable' || reading.reason !== 'not-read-yet') return reading;
  const reason = plan?.payer === 'api-key' ? 'vendor-console'
    : plan?.payer === 'custom-endpoint' ? 'custom-endpoint'
    : plan?.payer === 'not-signed-in' ? 'not-signed-in' : undefined;
  return reason ? { ...reading, reason } : reading;
}
