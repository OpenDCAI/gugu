/**
 * #6264 一台咕咕 server 有哪些「要人知道」的事:设备行上的标签、那台机器上会话末尾的那一行,都从这里取判据 ——
 * 两处说同一件事,❌ 各写一套。纯函数,读的只是那台机器随心跳报上来的几项(老宿主不报 = 不知道,不下结论)。
 */
import type { DeviceCapabilities } from '../shared/types/chat'

/**
 * 桌面↔server 这条线说的协议版本。有不兼容的改动时加一;server 同时报「桌面至少要哪一版」。
 * 照 VS Code / Zed 的「客户端与 server 版本对不上就明说」(Zed 发了旧客户端不认的消息直接断线:zed#42474),
 * 只是不要求逐版本相等 —— server 自动升级、桌面自动升级,两边总有先后。
 */
export const REMOTE_PROTOCOL_VERSION = 13
/**
 * server 报给桌面:桌面的协议版本低于它 = 这台电脑上的咕咕太旧。
 *
 * 2(#6264 一套工作台,server 0.2.156 起):别的机器上的会话改走会话页宿主协议(`taskhost.*`),
 * 旧桌面用的那组 `taskpage.*` 工作区 / 附件 / 登录 / 设置动词已删(只留手机用的会话动词)。
 * 旧桌面(协议 1)见到它会在设备行与那台机器上的会话末尾说「请更新这台电脑上的咕咕」—— 那是它自带的路;
 * 单个动词失败时它只会说「那台机器的 server 太旧」或「没做成」,拿不到服务端给的字,所以 ❌ 为删掉的动词留垫片。
 *
 * 3(#6914 删掉 task):会话页宿主上的 `tasks.*` 去掉了 11 个方法,会话 / 终端 / PR 类方法的参数从 task id 换成会话 id。
 * 两边谁旧都不兼容,所以两个下沿一起升到 3:旧桌面见到新 server 说「请更新」,新桌面见到旧 server 说它太旧
 * (SSH 装机那条路据此当场升级它),server 见到窗口外的桌面就请求换版。
 *
 * 4(PR-2 改名):会话页宿主的方法与参数跟着会话的名字改 —— 路由 `tasks.*` → `sessionCreate.*`、
 * `conversations.*` → `sessions.*`,参数里的 `conversationId` → `sessionId`。两边谁旧都不兼容,两个下沿一起升到 4。
 * `taskhost.*` 动词不改名:说版本的 hello 走的就是它,改了旧机器连「请更新」都说不出来。
 *
 * 5(远程 SSH 的机器处处能用,owner 2026-10-08 选 B):远程 SSH 的 server 改为接咕咕云转来的设备 RPC 与命令,
 * 设备连接上的 `device.command.handover` 删掉。只抬桌面这一侧的下沿:协议 4 的 server 不接咕咕云,手机和别的
 * 电脑用不了它 —— 说「版本太旧」(添加它的那台桌面据此当场替它升级)。server 这一侧的下沿留在 4:老桌面
 * 发 handover 拿到 `unknown_method`,它本来就当「server 太旧、不挡这条命令」处理,别的动作一字未变。
 *
 * 6(一套说法,owner 2026-10-08 ②「两个拍板都按你的推荐来」):手机也开 `taskhost.*` 窗口、问会话页路由表,
 * 手机那 21 个 `taskpage.session(s).*` 动词删掉;时间线 / 会话列表的推送改按订阅号发(事件 topic),
 * 订阅跟着窗口生灭。两边谁旧都不兼容(旧端听不带 topic 的推送,新端只推带 topic 的),两个下沿一起升到 6。
 * 开窗口时双方各报协议(`taskhost.open` 的 `protocol` 与应答里的 `protocol`),谁低于对方的下沿谁当场说「太旧」。
 *
 * 7(一张动词表):agent 的跨机器动作上会话页路由表(`agentSession.*`,经 `taskhost.call`),设备 RPC 上那三个动词删掉。
 * 窗口一字未变,两个下沿留在 6:只有 agent 跨机器那一问对协议 6 的机器说「太旧」。
 *
 * 8(列表推增量):会话列表订阅只剩一种推法 —— 订上那一刻一份整的,之后只推变了的行与没了的会话(381 条的机器一次
 * 状态变化从约 295 KB 变成约 1 KB)。旧端只认整份、新端只推增量,两边谁旧都不兼容,两个下沿一起升到 8。
 *
 * 9(#7233 一个发问端一条线):咕咕云上,发问端先在这台机器的共用 topic 上报到(`taskhost.attach`),之后请求、回包、
 * 窗口回帧都走它自己那条 `gugu:<dev>:rpc:<asker>`;共用 topic 上只剩报到、`taskhost.ready`、`taskhost.alive`。
 * 旧端在共用 topic 上直接问,新机器回 `client_outdated`(「请更新」);新端报到,旧机器回 `unknown_method`(「请更新那台机器」)。
 * 两边谁旧都不兼容(owner 10-08:不留两条路),两个下沿一起升到 9。远程 SSH 的设备连接本来就是一对一,不报到。
 *
 * 10(App 页的跨机器调用只剩一个动作):页面在别的机器的会话里时,跟着那台机器的动词(`BRIDGE_VERBS` 的 `machine`:数据目录、
 * 程序)一律走 `agentSession.app_call { method, args }`,那台机器查同一张表、用同一份实现做;`call_program` / `app_data` 删掉,
 * 跨机器的数据文件随之是一次调用的上限 1 MB(owner 10-17「更优雅的话就去做吧」)。窗口一字未变,两个下沿留在 9(同 7):
 * 只有这一问对协议 9 的机器说「太旧」(那台的路由表答 No handler)。
 *
 * 11(会话消息带原文件):消息动作保留附件引用。发文件前要求目标至少为11，避免旧宿主忽略引用却回报投递成功。
 * 纯文字、任务控制与窗口不变，两个通用下沿仍为9。
 *
 * 12(历史按改动游标取,10-26 devdb 出口事故):会话页对账不再每提交一轮重读整份历史,改成带着改动游标
 * (`getHistory` 的 `changedSince`,应答带 `cursor` / `count`)只取新增 / 改过的那几轮(@@@history-change-cursor)。
 * Both ends require protocol 12: a new desktop cannot reconcile an old host's history; an old desktop
 * would keep rereading full pages from a new host. Reject both version mismatches through the existing
 * client_outdated / server_outdated path, on cloud and SSH alike, rather than retaining the old transfer.
 */
/**
 * 13: Ask settlements use origin instead of host.
 *
 * 向下兼容一档(owner 10-28,换版打断 7 条车道之后):两边只差一档时照常连,由**新的一侧**降级 ——
 * 新宿主照旧带上 12 读的字段(Settlement.host、浏览器状态里的 assistance),新桌面收进来时把 12 的字段读成新名
 * (settlementFromWire),开窗时按那台机器的协议报 hello(`helloProtocol`):12 的老宿主见到 13 会当成版本信号、
 * 要求当场换版,有 agent 在跑也照换。差两档以上才说「太旧」。下一次加一时,两个下沿跟着抬到新号减一。
 */
export const MIN_CLIENT_PROTOCOL = 12
/** 桌面 / 手机自己的要求:那台机器报的协议版本低于它 = 那台机器上的咕咕太旧(同样向下兼容一档)。 */
export const MIN_SERVER_PROTOCOL = 12

/** 开窗时报给那台机器的协议:它比这台低、但还在兼容的一档里,就照它的报(见上);说不出 = 报自己的。纯函数。 */
export function helloProtocol(serverProtocol: number | null | undefined, own = REMOTE_PROTOCOL_VERSION, minServer = MIN_SERVER_PROTOCOL): number {
  return typeof serverProtocol === 'number' && serverProtocol < own && serverProtocol >= minServer ? serverProtocol : own
}

/**
 * 那台 server 说的协议版本够不够这台桌面用 —— 设备行 / 会话末尾(心跳报的 remote_protocol)与 SSH 装机时
 * 探到的(`gugu-server protocol`)是同一个判据,❌ 各写一套。
 * 说不出协议(null / undefined)怎么算由调用方说:心跳那头是「老宿主不报 = 不知道」;装机那头 server 就在手边,
 * 连这条命令都不认 = 比这台桌面要求的还老(照 VS Code Remote-SSH:装着的与客户端对不上就装一份对得上的)。
 */
export function serverProtocolTooOld(
  protocol: number | null | undefined,
  options: { unknownIsTooOld: boolean; minServer?: number } = { unknownIsTooOld: false },
): boolean {
  if (protocol === null || protocol === undefined) return options.unknownIsTooOld
  return protocol < (options.minServer ?? MIN_SERVER_PROTOCOL)
}

/** 余量低于它就提醒:一次升级要下载并解开约 400MB 的包,agent 装一次也是几百 MB。 */
export const SERVER_DISK_LOW_BYTES = 1024 * 1024 * 1024

export type ServerMachineNotice =
  | { kind: 'desktop-too-old' }
  | { kind: 'server-too-old' }
  | { kind: 'disk-low'; freeBytes: number }
  | { kind: 'rolled-back'; version: string; restored: string }

/**
 * 按要紧程度排:版本对不上(功能会直接失败)> 磁盘快满(升级、保存、登录态续期都会失败)> 升级被退回(已经自愈,只是告知)。
 */
export function serverMachineNotices(
  capabilities: Pick<DeviceCapabilities, 'host_kind' | 'server_disk' | 'server_rollback' | 'remote_protocol' | 'min_client_protocol'> | null | undefined,
  own: { protocol: number; minServer: number } = { protocol: REMOTE_PROTOCOL_VERSION, minServer: MIN_SERVER_PROTOCOL },
): ServerMachineNotice[] {
  if (!capabilities) return []
  const notices: ServerMachineNotice[] = []
  if (capabilities.min_client_protocol !== undefined && capabilities.min_client_protocol > own.protocol) {
    notices.push({ kind: 'desktop-too-old' })
  } else if (serverProtocolTooOld(capabilities.remote_protocol, { unknownIsTooOld: false, minServer: own.minServer })) {
    notices.push({ kind: 'server-too-old' })
  }
  // Protocol windows apply to every task host; disk/update notices belong to headless servers.
  if (capabilities.host_kind !== 'server') return notices
  const disk = capabilities.server_disk
  if (disk && disk.free_bytes < SERVER_DISK_LOW_BYTES) notices.push({ kind: 'disk-low', freeBytes: disk.free_bytes })
  const rollback = capabilities.server_rollback
  if (rollback) notices.push({ kind: 'rolled-back', version: rollback.version, restored: rollback.restored })
  return notices
}

/** 给人看的容量:「312 MB」「1.4 GB」。 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.max(0, Math.round(bytes / 1024))} KB`
}

/** #6264 设备行点「重试」换到匹配版本的那条设备调用(界面也要用,所以放在不碰文件系统的这里)。 */
export const VERSION_RETRY_RPC = 'server.versionMatch.retry'

/**
 * #6264 报给那台机器的「这是哪一台桌面」:设备编号 + 版本。设备编号跟着硬件走,同一台电脑上的正式版、Beta、
 * 开发实例是同一个编号 —— 只按编号记,两个版本会互相覆盖,账号在两版之间来回切(实测 d22 每十几秒切一次)。
 * 带上版本各记一条,那台机器照旧取最新的那一版(同一账号按新的一边跑)。
 */
export function desktopReportId(deviceId: string, version: string): string {
  return `${deviceId}:${version.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 128)
}
