// #137 选着的那台机器此刻用不了,说给人听的那一条提示(右下角的统一提示条,❌ 输入框下面的一行字):
// 一台机器一条,同一条原地换 —— 重连中(第几次)→ 离线 / 失败,或 → 已连上,❌ 每一步各发一条。
// 纯函数(翻译注入)+ 一个把它挂到统一出口上的 hook;每条判据都有单测。
import { useEffect } from 'react';
import { dismissNotice, notify, type Notice } from '@/lib/notices';
import { machineBlockIsStatus, machineUnavailableReason, type HostConnectionState, type Translate } from './connection-status';

/**
 * 正在连 / 重连的提示等这么久才出现:一次转瞬的重连(几百毫秒)不值得打扰人 ——
 * 出现又消失的提示本身就是闪烁。已经出现了的,后面的变化立刻换,不再等。
 */
export const CONNECTING_NOTICE_DELAY_MS = 2_500;

export type MachineNoticeSpec = Pick<Notice, 'title' | 'description' | 'tier' | 'waiting'> & {
  /** 是个「还在试」的状态:先等 CONNECTING_NOTICE_DELAY_MS 看会不会自己好。 */
  delayed: boolean;
};

export function machineNotice(input: {
  /** null = 名下已经没有这台机器(设备行不在了):按「用不了」说,❌ 当没事。 */
  connection: HostConnectionState | null;
  label: string | null;
  /** 到那台机器的线自上次连通以来拨过几次(RemoteHostsStore.dialsSinceOpen)。 */
  dials: number;
  wakeFailure?: string | null;
  signInExpiredAt?: string | null;
  translate: Translate;
}): MachineNoticeSpec | null {
  const { connection, label, dials, translate } = input;
  if (connection === 'connected') return null;
  const trying = connection === 'connecting' || connection === 'reconnecting';
  // 第一次拨不算「重试」;连上过的机器断了,拨的每一次都是。
  const retries = connection === 'connecting' ? dials - 1 : dials;
  return {
    title: machineUnavailableReason(connection, label, translate, input.wakeFailure, input.signInExpiredAt),
    description: trying && retries >= 1 ? translate('remoteHost.status.attempt', { count: retries }) : undefined,
    // 离线 / 休眠 / 正在连只是那台此刻用不了;叫醒没成、要先登录、版本太旧是要人知道、可能要人去做点什么的事。
    tier: machineBlockIsStatus(connection, input.signInExpiredAt) ? 'info' : 'error',
    waiting: trying || connection === 'waking' || connection === 'updating',
    delayed: trying,
  };
}

const noticeKey = (deviceId: string) => `machine:${deviceId}`;

/** 现在在屏幕上(或排着要出现)的机器提示的 key → 有几个新建框在用它。最后一个走了才收。 */
const users = new Map<string, number>();
/** 提示已经出现过、还没结束的机器:恢复时才说「已连上」;用户亲手关掉的不再打扰。 */
const live = new Set<string>();
const closedByUser = new Set<string>();
/** 在等「会不会自己好」的机器:最新的内容 + 那一个计时。内容变了只换内容,❌ 重新计时(第几次每拨一次就变)。 */
const pending = new Map<string, { spec: MachineNoticeSpec; timer: ReturnType<typeof setTimeout> }>();

function clearPending(deviceId: string): void {
  const waiting = pending.get(deviceId);
  if (!waiting) return;
  clearTimeout(waiting.timer);
  pending.delete(deviceId);
}

function show(deviceId: string, spec: MachineNoticeSpec): void {
  live.add(deviceId);
  notify({
    key: noticeKey(deviceId),
    title: spec.title,
    description: spec.description,
    tier: spec.tier,
    waiting: spec.waiting,
    ongoing: true,
    onDismiss: () => {
      // 我们自己收的(换机器 / 恢复)时 live 已经清了,不是用户关的。
      if (live.delete(deviceId)) closedByUser.add(deviceId);
    },
  });
}

/**
 * 把选着的机器的状况挂到统一提示条上。须在每次渲染都读到最新读数的地方调用(observer 组件里)。
 * `spec` 为 null = 连着 / 没选别的机器。换了机器 / 新建框走了:收掉它的提示。
 */
export function useMachineNotice(deviceId: string | null, label: string, spec: MachineNoticeSpec | null, translate: Translate): void {
  useEffect(() => {
    if (!deviceId) return;
    users.set(deviceId, (users.get(deviceId) ?? 0) + 1);
    return () => {
      const left = (users.get(deviceId) ?? 1) - 1;
      if (left > 0) return void users.set(deviceId, left);
      users.delete(deviceId);
      // 同一次提交里旧新建框卸载、新的接上(比如整页换成对话页的创建草稿):别在这中间把提示收了又立刻重发 ——
      // sonner 的收是排队执行的,重发不会取消它,新的那条会连同「用户关的」标记一起被误杀。等这一拍过完再看还有没有人在用。
      queueMicrotask(() => {
        if (users.has(deviceId)) return;
        clearPending(deviceId);
        closedByUser.delete(deviceId);
        // 先记下「是我要收」,onDismiss 才分得出这不是用户关的。
        if (live.delete(deviceId)) dismissNotice(noticeKey(deviceId));
      });
    };
  }, [deviceId]);

  const signature = spec ? JSON.stringify([spec.title, spec.description ?? null, spec.tier, spec.waiting]) : null;
  useEffect(() => {
    if (!deviceId) return;
    if (!spec) {
      clearPending(deviceId);
      // 出现过的问题好了:在原来那一条上换成「已连上」。用户关掉了的、根本没出现过的(一眨眼就好了)不说。
      if (live.delete(deviceId)) notify({ key: noticeKey(deviceId), title: translate('remoteHost.status.connected', { device: label }), tier: 'success' });
      closedByUser.delete(deviceId);
      return;
    }
    if (closedByUser.has(deviceId)) return;
    if (!spec.delayed || live.has(deviceId)) {
      clearPending(deviceId);
      return show(deviceId, spec);
    }
    const waiting = pending.get(deviceId);
    if (waiting) {
      waiting.spec = spec;
      return;
    }
    const timer = setTimeout(() => {
      const latest = pending.get(deviceId);
      pending.delete(deviceId);
      if (latest) show(deviceId, latest.spec);
    }, CONNECTING_NOTICE_DELAY_MS);
    pending.set(deviceId, { spec, timer });
    // 按提示的内容重跑;spec / translate 每次渲染都是新对象,signature 才是变没变。
  }, [deviceId, signature]);
}
