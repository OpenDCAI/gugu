import type { SessionpageSessionEvent, SessionpageSessionsEvent } from '@gugu/session-core/session-record';
import { defineEvent } from '@shared/lib/ipc/events';
import type { TaskExchangePage } from '../sessions/task-collaboration';

export const taskExchangeChannel = defineEvent<TaskExchangePage>('session:task-exchanges');

/**
 * 时间线推送口:本机窗口、别的电脑、手机都从这里收(topic = subscriptionId,只有订了它的那条线收得到)。
 */
/*
 * ⚠️ 通道名**不带 `sessionpage:` 前缀**:那个前缀是壳 IPC(`shell-port.ts` 里那张表)保留的,
 * check-session-shell-port 会把 session 树里任何 `sessionpage:` 字面量判红 —— 它防的是
 * 「绕过壳端口直接 invoke」那类写法(网页版把宿主与壳拆开后那些调用全部无人应答)。
 * 这条是渲染层的**事件广播**,不经壳端口,所以按同目录其它事件的写法命名
 * (files:changes / fs:file-tree-projection / automation:changed)。
 */
export const sessionpageSessionTimelineChannel =
  defineEvent<SessionpageSessionEvent>('session-timeline:push');

/** 整台机器的会话列表推送口(topic = subscriptionId)。 */
export const sessionpageSessionListChannel = defineEvent<SessionpageSessionsEvent>('session-list:push');
