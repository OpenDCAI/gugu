// #6264 一套工作台的缝:每次 `rpc.*` 调用 / 事件订阅,按它说的是哪台机器上的东西选线
// (behavior gugu-server.md 第 8 条:别的机器上的会话与本机同一套界面与能力,只差请求走本机还是走到那台机器)。
//
// 机器是实体的属性(照 Zed:项目属于一台机器,❌ 整页有一个「当前机器」)。所以不靠调用点声明,而是认参数里的实体 id:
//   · 项目 / 任务 / 会话 / 工作区 / 终端的 id —— 远端机器的项目清单、它的应答与推送里出现过的,都记在这里;
//   · pty 会话 id(`<projectId>:<scope>:<leaf>`)按前缀的项目认。
// 认不出的一律本机:本机库里没有那台机器的 uuid,错走本机只会当场「找不到」,❌ 悄悄改错东西。
// 本机专属的命名空间(窗口、内置浏览器、界面布局记忆、SSH 直连 / 端口转发)永不外发;
// 机器级的调用(那台机器的设置、资源库、模型目录……)由调用点经 `rpcOn(machine)` 指明。

import { IMPLICIT_SESSION_HOME_PROJECT_ID } from '@shared/core/projects/session-home-project';

/** 一次调用里认出的机器:null = 本机。 */
export type RoutedMachine = string | null;

export class MachineRoutingConflictError extends Error {
  constructor(channel: string, machines: readonly string[]) {
    super(`[machine-routing] ${channel} 的参数同时指向几台机器: ${machines.join(', ')}`);
    this.name = 'MachineRoutingConflictError';
  }
}

/** 这些命名空间属于看界面的这台电脑,永不外发(宿主那一侧也挡着,见 device-session-host.ts)。 */
const LOCAL_ONLY_NAMESPACES = new Set([
  'app',
  'browser',
  'remotePorts',
  'viewState',
  'extensions',
  'resourceMonitor',
]);

/**
 * 带着项目 id、却属于这台电脑的几条:`gugu-preview://` 的登记表在看界面的这台电脑的主进程里
 * (别的机器上的页面由这台电脑按块取来渲染,见 preview-protocol.ts)。
 */
const LOCAL_ONLY_CHANNELS = new Set([
  'workspace.files.createDocumentPreview',
  'workspace.files.createRemotePreview',
  'workspace.files.setPreviewDocument',
  'workspace.files.releasePreview',
]);

/** 值是实体 id 的键(会话页宿主自己的实体;❌ 咕咕云身份那类跨机器的 id,那会把本机调用错发出去)。 */
const ENTITY_KEYS = new Set(['projectId', 'sessionId', 'workspaceId', 'terminalId']);
/** 带了这些键的对象,它自己的 `id` 也是那台机器上的实体(会话、终端)。 */
const OWNER_KEYS = ['projectId', 'sessionId'];

const MAX_WALK_NODES = 5_000;
const MAX_WALK_DEPTH = 6;

function looksLikeEntityId(value: unknown): value is string {
  // 上限盖住最长的那种:隐藏任务工作区的 pty 会话 id(`<固定 id>~<机器>:<任务>:<会话>`,约 150 字)。
  return typeof value === 'string' && value.length >= 8 && value.length <= 256 && !/[\s/\\]/.test(value);
}

export class MachineRegistry {
  private readonly owner = new Map<string, string>();

  /** 每台机器都有、id 写死的实体(见文件末尾的换名);它们本身永不登记。 */
  constructor(readonly fixedIds: readonly string[] = []) {}

  /** 记下这些 id 属于那台机器。 */
  register(deviceId: string, ids: Iterable<string>): void {
    for (const id of ids) {
      if (looksLikeEntityId(id) && !this.fixedIds.includes(id)) this.owner.set(id, deviceId);
    }
  }

  /** 那台机器被移除 / 换了账号:忘掉它的 id。 */
  forgetMachine(deviceId: string): void {
    for (const [id, owner] of this.owner) if (owner === deviceId) this.owner.delete(id);
  }

  /** 从那台机器来的一份数据(应答 / 推送 / 发过去的参数):把里面的实体 id 记到它名下。 */
  absorb(deviceId: string, value: unknown): void {
    const ids: string[] = [];
    collectEntityIds(value, ids);
    this.register(deviceId, ids);
  }

  /** 这个 id(或 pty 会话 id)在哪台机器上;null = 本机 / 不认识。 */
  machineOf(id: string): RoutedMachine {
    const aliased = machineOfAlias(id, this.fixedIds);
    if (aliased) return aliased;
    const direct = this.owner.get(id);
    if (direct) return direct;
    const colon = id.indexOf(':');
    if (colon > 0) return this.owner.get(id.slice(0, colon)) ?? null;
    return null;
  }

  /** 这次调用该走哪台机器。 */
  route(channel: string, args: readonly unknown[]): RoutedMachine {
    const namespace = channel.split('.', 1)[0] ?? '';
    if (LOCAL_ONLY_NAMESPACES.has(namespace) || LOCAL_ONLY_CHANNELS.has(channel)) return null;
    const found = new Set<string>();
    this.scan(args, found, 0, { nodes: 0 });
    if (found.size === 0) return null;
    if (found.size > 1) throw new MachineRoutingConflictError(channel, [...found]);
    return [...found][0]!;
  }

  private scan(value: unknown, found: Set<string>, depth: number, budget: { nodes: number }): void {
    if (budget.nodes++ > MAX_WALK_NODES || depth > MAX_WALK_DEPTH) return;
    if (typeof value === 'string') {
      const machine = looksLikeEntityId(value) ? this.machineOf(value) : null;
      if (machine) found.add(machine);
      return;
    }
    if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return;
    if (Array.isArray(value)) {
      for (const item of value) this.scan(item, found, depth + 1, budget);
      return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) this.scan(child, found, depth + 1, budget);
  }
}

/** 一份数据里的实体 id(按 ENTITY_KEYS / OWNER_KEYS 的规矩)。 */
export function collectEntityIds(value: unknown, out: string[], depth = 0, budget = { nodes: 0 }): void {
  if (budget.nodes++ > MAX_WALK_NODES || depth > MAX_WALK_DEPTH) return;
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) collectEntityIds(item, out, depth + 1, budget);
    return;
  }
  const record = value as Record<string, unknown>;
  const owned = OWNER_KEYS.some((key) => looksLikeEntityId(record[key]));
  for (const [key, child] of Object.entries(record)) {
    if (ENTITY_KEYS.has(key) || (key === 'id' && owned)) {
      if (looksLikeEntityId(child)) out.push(child);
      continue;
    }
    if (child && typeof child === 'object') collectEntityIds(child, out, depth + 1, budget);
  }
}

/**
 * 订阅频道 `<事件>.<topic>` 在哪台机器上。事件总线(shared/lib/ipc/events.ts)交给适配器的是拼好的频道、
 * ❌ 不单给 topic —— 所以按频道认,不能只看 topic 参数(隐藏任务工作区的 pty 输出就是这么丢的:
 * 频道没换名就去每台机器上订 `pty:data.<别名>`,那台机器只推 `pty:data.<固定 id>`)。
 */
export function machineOfChannel(registry: MachineRegistry, channel: string): RoutedMachine {
  const dot = channel.indexOf('.');
  return dot > 0 ? registry.machineOf(channel.slice(dot + 1)) : null;
}

export const machineRegistry = new MachineRegistry([IMPLICIT_SESSION_HOME_PROJECT_ID]);

// ── 每台机器都有、id 写死的那几个实体 ─────────────────────────────────────────────
// 会话页宿主有一个 id 固定的隐藏项目(没选文件夹时会话跑在它里面,session-home-project.ts)。本机有,每台
// 别的机器也有,id 一模一样 —— 按 id 选线就分不清了。所以在机器边界上给它换个名字:从那台机器来的
// `<固定 id>` 在这边叫 `<固定 id>~<机器>`,发过去时换回来(pty 会话 id 的项目段同理)。只换这一个值,
// 其余一概原样。

export const MACHINE_ALIAS_SEPARATOR = '~';

export function aliasFixedId(fixedId: string, deviceId: string): string {
  return `${fixedId}${MACHINE_ALIAS_SEPARATOR}${deviceId}`;
}

/** `<固定 id>~<机器>` → 那台机器;不是别名 = null。 */
export function machineOfAlias(value: string, fixedIds: readonly string[]): string | null {
  for (const fixedId of fixedIds) {
    if (value.startsWith(fixedId + MACHINE_ALIAS_SEPARATOR)) {
      const rest = value.slice(fixedId.length + 1);
      const colon = rest.indexOf(':');
      return colon === -1 ? rest : rest.slice(0, colon);
    }
  }
  return null;
}

type StringMapper = (value: string) => string;

/** 深拷贝时只改需要改的字符串;一处都没改就原样返回同一个对象。 */
export function mapStrings<T>(value: T, map: StringMapper, depth = 0): T {
  if (typeof value === 'string') return map(value) as T;
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || depth > 12) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const mapped = mapStrings(item, map, depth + 1);
      if (mapped !== item) changed = true;
      return mapped;
    });
    return (changed ? next : value) as T;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const mapped = mapStrings(child, map, depth + 1);
    if (mapped !== child) changed = true;
    next[key] = mapped;
  }
  return (changed ? next : value) as T;
}

/** 这台机器的边界换名:发出去(别名 → 固定 id)与收进来(固定 id → 别名)。 */
export function machineIdCodec(deviceId: string, fixedIds: readonly string[]) {
  const toAlias = new Map(fixedIds.map((id) => [id, aliasFixedId(id, deviceId)]));
  const fromAlias = new Map(fixedIds.map((id) => [aliasFixedId(id, deviceId), id]));
  const rewrite = (table: Map<string, string>): StringMapper => (value) => {
    const exact = table.get(value);
    if (exact !== undefined) return exact;
    const colon = value.indexOf(':');
    if (colon > 0) {
      const head = table.get(value.slice(0, colon));
      if (head !== undefined) return head + value.slice(colon);
    }
    return value;
  };
  /** 事件频道名 `<事件>.<topic>`:只换 topic 那一段。 */
  const rewriteChannel = (map: StringMapper) => (channel: string): string => {
    const dot = channel.indexOf('.');
    if (dot <= 0) return channel;
    const topic = channel.slice(dot + 1);
    const mapped = map(topic);
    return mapped === topic ? channel : channel.slice(0, dot + 1) + mapped;
  };
  const outbound = rewrite(fromAlias);
  const inbound = rewrite(toAlias);
  return {
    outbound: <T>(value: T): T => mapStrings(value, outbound),
    inbound: <T>(value: T): T => mapStrings(value, inbound),
    outboundChannel: rewriteChannel(outbound),
    inboundChannel: rewriteChannel(inbound),
  };
}

const codecs = new Map<string, ReturnType<typeof machineIdCodec>>();

/** 这台机器的边界换名(按机器缓存一份)。 */
export function machineCodec(deviceId: string): ReturnType<typeof machineIdCodec> {
  let codec = codecs.get(deviceId);
  if (!codec) codecs.set(deviceId, (codec = machineIdCodec(deviceId, machineRegistry.fixedIds)));
  return codec;
}
