import { defineEvent } from '@shared/lib/ipc/events';

/**
 * 切订阅时关会话的进度:这一家要关几个、已经关完几个。开始关时推一次(0 / 总数),每关完一个再推一次;
 * 「关掉并切换」那一行据此画进度条 —— 读的是真关掉了几个,❌ 按时间估。
 */
export const subscriptionSwitchProgressChannel = defineEvent<{
  providerId: string;
  closed: number;
  total: number;
}>('subscriptions:switch-progress');
