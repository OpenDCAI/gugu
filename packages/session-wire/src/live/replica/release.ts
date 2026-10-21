import type { Unsubscribe } from '@gugu/session-shared';

/**
 * @@@replica-failed-ready — 副本的 `ready` 一旦拒了(快照失败:会话还没建 / 已拆的 NOT_FOUND、运行时崩溃时在途的
 * DISCONNECTED;或 attach 失败),这个副本就用不上了:
 * 调用方拿到的是错误,手里多半连这个对象都没有(`await replica.ready` 直接抛了出去),不会再有人来 dispose。
 * 可它的 attach 可能已经在连接上挂住了 —— 推送回调和 onReattach 留在连接那份 attachment 里,这个主题永远不
 * detach,服务端一直往这边推;运行时重启、连接重连时它还会 refresh、重新 seed,变成一个没人拿着却在收数据、
 * 还在触发 onChange 的副本。同一个 key 每失败一次就再叠一份。
 * ⇒ `ready` 拒绝之前先把这次 attach 放掉,拒绝的原因原样抛出。要重试就新建一个副本。
 */
export function releaseOnFailedReady(ready: Promise<void>, release: () => Promise<void>): Promise<void> {
  return ready.catch(async (error: unknown) => {
    await release();
    throw error;
  });
}

/** 放掉一次 attach。attach 本身失败了就没有可放的 —— 连接那侧已经自己清掉,❌ 再把那个错误抛给 dispose 的调用方。 */
export async function detachSettled(detachPromise: Promise<Unsubscribe>): Promise<void> {
  const detach = await detachPromise.catch(() => null);
  detach?.();
}
