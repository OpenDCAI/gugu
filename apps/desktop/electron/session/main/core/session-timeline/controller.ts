import type {
  SessionpageSessionAfterRequest,
  SessionpageSessionCancelRequest,
  SessionpageSessionCreateModelsRequest,
  SessionpageSessionCreateRequest,
  SessionpageOpenedFileReadRequest,
  SessionpageSessionOlderRequest,
  SessionpageSessionReloadModelRequest,
  SessionpageSessionRespondRequest,
  SessionpageSessionSendRequest,
  SessionpageSessionSetOptionRequest,
  SessionpageSessionSnapshotRequest,
  SessionpageSessionSubscribeRequest,
  SessionpageSessionToolImageRequest,
  SessionpageSessionUnsubscribeRequest,
  SessionpageSessionUpdateRequest,
} from '@gugu/session-core/session-record';
import {
  trimAfterResultForTransport,
  trimOlderForTransport,
  trimSnapshotForTransport,
} from '@gugu/session-core/session-record';
import { events } from '@main/lib/events';
import {
  sessionpageSessionListChannel,
  sessionpageSessionTimelineChannel,
} from '@shared/core/session-timeline/sessionTimelineEvents';
import { createRPCController, withSender } from '@shared/lib/ipc/rpc';
import * as create from './create-session';
import * as service from './service';
import { readTaskExchanges, watchTaskExchanges, unwatchTaskExchanges } from './task-exchanges';
import type { TaskExchangeRequest } from '@shared/core/sessions/task-collaboration';
import { taskExchangeChannel } from '@shared/core/session-timeline/sessionTimelineEvents';

/**
 * 会话时间线的口:本机窗口、别的电脑、手机问的都是这一张(经会话页宿主那条线;别的机器上走 `taskhost.*`)。
 *
 * 推送按订阅号发(事件的 topic = subscriptionId):只有订了它的那条线收得到,❌ 一件事推给每台看着的电脑。
 * 订阅归开它的那条线:线断了(手机被杀、合盖、断网)一并拆掉 —— 寿命跟着连接走,❌ 另设保活与清扫
 * (`releaseSubscriptionsOf`,会话页宿主在连接关掉时调)。
 *
 * `trim`:调用方要「过长的工具内容裁掉」的那一份(手机)。桌面不给,一个字都不裁。
 */
const owned = new Map<number, { timeline: Set<string>; sessions: Set<string>; exchanges: Set<string> }>();

function ownedBy(sender: number) {
  let entry = owned.get(sender);
  if (!entry) owned.set(sender, (entry = { timeline: new Set(), sessions: new Set(), exchanges: new Set() }));
  return entry;
}

/** 一条线断了:它开的订阅全拆。 */
export function releaseSubscriptionsOf(sender: number): void {
  const entry = owned.get(sender);
  if (!entry) return;
  owned.delete(sender);
  for (const id of entry.timeline) service.unsubscribe(id);
  for (const id of entry.sessions) service.unsubscribeSessions(id);
  for (const id of entry.exchanges) unwatchTaskExchanges(`${sender}:${id}`);
}

/**
 * 订阅在等的时候就记在这条线名下:等的那一会儿里线断了(releaseSubscriptionsOf),拆得到它;没订成再从名下摘掉。
 * ❌ 订成之后才记 —— 那时线可能已经死了,这条订阅就再也没人拆。
 */
async function owning<T extends { ok: boolean }>(sender: number, kind: 'timeline' | 'sessions', id: string, start: () => Promise<T>): Promise<T> {
  ownedBy(sender)[kind].add(id);
  const result = await start();
  if (!result.ok) owned.get(sender)?.[kind].delete(id);
  return result;
}

function trimmed<T>(result: service.SessionTimelineResult<T>, trim: boolean | undefined, cut: (value: T) => T) {
  return trim && result.ok ? { ok: true as const, value: cut(result.value) } : result;
}

export const sessionTimelineController = createRPCController({
  taskExchanges: (input: TaskExchangeRequest) => readTaskExchanges(input),
  taskExchangesSubscribe: withSender(async (sender: number, input: TaskExchangeRequest & { subscriptionId: string }) => {
    const page = readTaskExchanges(input);
    let cursor = page.cursor;
    ownedBy(sender).exchanges.add(input.subscriptionId);
    watchTaskExchanges(`${sender}:${input.subscriptionId}`, input, () => {
      let next;
      do {
        next = readTaskExchanges({ ...input, after: cursor });
        cursor = next.cursor;
        events.emit(taskExchangeChannel, next, input.subscriptionId);
      } while (next.hasMore);
    });
    return page;
  }),
  taskExchangesUnsubscribe: withSender(async (sender: number, { subscriptionId }: { subscriptionId: string }) => {
    if (owned.get(sender)?.exchanges.delete(subscriptionId)) unwatchTaskExchanges(`${sender}:${subscriptionId}`);
  }),
  sessionsList: async () => service.listSessions(),
  sessionSnapshot: async (input: SessionpageSessionSnapshotRequest) =>
    trimmed(await service.snapshot(input), input.trim, trimSnapshotForTransport),
  sessionAfter: async (input: SessionpageSessionAfterRequest) =>
    trimmed(await service.after(input), input.trim, trimAfterResultForTransport),
  sessionOlder: async (input: SessionpageSessionOlderRequest) =>
    trimmed(await service.older(input), input.trim, trimOlderForTransport),
  /** 一张工具交回来的图(手机那份时间线里只有它的类型和字数)。 */
  sessionToolImage: async (input: SessionpageSessionToolImageRequest) => service.toolImage(input),
  sessionSubscribe: withSender(async (sender: number, input: SessionpageSessionSubscribeRequest) =>
    owning(sender, 'timeline', input.subscriptionId, () => service.subscribe(input, (event) =>
      events.emit(
        sessionpageSessionTimelineChannel,
        input.trim ? { ...event, result: trimAfterResultForTransport(event.result) } : event,
        input.subscriptionId
      )
    ))),
  // 只拆自己开的:订阅号对别的线是不透明的,但「不该做得到」不靠「猜不中」(一问一答的 taskhost.call 也算别的线)。
  sessionUnsubscribe: withSender(async (sender: number, input: SessionpageSessionUnsubscribeRequest) => {
    if (!owned.get(sender)?.timeline.delete(input.subscriptionId)) return;
    service.unsubscribe(input.subscriptionId);
  }),
  /** 整台机器的会话列表(谁此刻卡在人这儿):订上那一刻推一份整的,之后有变化只推变了的行。 */
  sessionsSubscribe: withSender(async (sender: number, { subscriptionId }: SessionpageSessionUnsubscribeRequest) =>
    owning(sender, 'sessions', subscriptionId, () => service.subscribeSessions(subscriptionId, (event) =>
      events.emit(sessionpageSessionListChannel, event, subscriptionId)
    ))),
  sessionsUnsubscribe: withSender(async (sender: number, { subscriptionId }: SessionpageSessionUnsubscribeRequest) => {
    if (!owned.get(sender)?.sessions.delete(subscriptionId)) return;
    service.unsubscribeSessions(subscriptionId);
  }),
  /** 手机点开附件卡(#7193):这条会话打开给人看的那份文件,按块读;只认它真的打开过的。 */
  sessionOpenedFileRead: (input: SessionpageOpenedFileReadRequest) => service.readOpenedFile(input),
  /** 这条会话给人打开过什么(桌面「输出」、手机):会话所在这台机器上的那一份(sessions/session-outputs.ts)。 */
  sessionOutputs: (input: { conversationId: string }) => service.outputs(input),
  sessionBackgroundTasks: (input: { conversationId: string }) => service.backgroundTasks(input),
  sessionStopBackgroundTask: (input: { conversationId: string; stopId: string }) => service.stopBackgroundTask(input),
  sessionQueue: (input: Parameters<typeof service.changeQueue>[0]) => service.changeQueue(input),
  sessionSend: (input: SessionpageSessionSendRequest) => service.send(input.conversationId, input.text),
  sessionRespond: (input: SessionpageSessionRespondRequest) => service.respond(input),
  sessionCancel: (input: SessionpageSessionCancelRequest) => service.cancel(input.conversationId),
  sessionUpdate: (input: SessionpageSessionUpdateRequest) => service.updateSession(input),
  sessionOptions: (input: { conversationId: string }) => service.sessionOptions(input),
  sessionSetOption: (input: SessionpageSessionSetOptionRequest) => service.setSessionOptionValue(input),
  sessionReloadModel: (input: SessionpageSessionReloadModelRequest) => service.reloadSessionModel(input),
  /** 新建前问:这台机器上有哪些项目、装了哪几家 harness。 */
  sessionCreateOptions: () => create.createOptions(),
  /** 选定的 harness 在这台机器上能跑哪些模型。 */
  sessionCreateModels: (input: SessionpageSessionCreateModelsRequest) => create.createModels(input),
  /**
   * 起一条建好了、还没开起来的会话(「再试一次」那一步;第一句话随之投递)。gugu-dev#181:建完不打开的创建
   * (项目里、聊天里派任务)没有会话页去起它,建完就调这一句。已经起过的什么都不做。
   */
  sessionStart: (input: { conversationId: string }) => create.startSession(input.conversationId),
  /** 在这台机器上开一条新会话;应答带上列表里那一行,调用方不必再列一遍。 */
  sessionCreate: async (input: SessionpageSessionCreateRequest) => {
    const created = await create.createSession(input);
    const session = created.ok ? await service.sessionSummary(created.value.conversationId) : null;
    return session && created.ok ? { ...created, value: { ...created.value, session } } : created;
  },
});
