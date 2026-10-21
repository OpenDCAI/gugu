/**
 * #857 Listen Mode 引擎 — 纯函数核心层
 *
 * 职责：NO_REPLY 解析 / default 解析。「这条消息唤醒谁」不在这里 —— 那是云端 chat.message_wakes_agent 一处的事。
 * 约束：无 IO、无 import electron/supabase、纯 TS 函数
 */

import type { ListenMode } from '../shared/types/chat'
import { failLoudInDev } from '../shared/failLoudInDev'

// 旧 buildListenModeSystemHint(群聊味 listen-mode 长文,不分 chat kind 注入)已退役:应答纪律由
// 平台块 gugu_silence 段(session 级系统通道)承载,每轮只在投递信封上带 listen_mode 属性一词。
// #4191 取证:私聊里出现群聊长文正是它当年的缺陷;删除时(2026-08-25)全仓零生产调用方。

// 注:无「流式期哨兵前缀」判定(原 isNoReplyStreamingPrefix)。#1671 起聊天不再渲染 agent 的裸 ACP
// 文本流(裸流违背「Plain ACP text is not a chat reply」契约),哨兵不可能流式露面,故无需该 gate。

// ─────────────────────────────────────────────
// 3. resolveListenModeDefault
// ─────────────────────────────────────────────

/**
 * 将 'default'/null/undefined/空串 解析为正规 ListenMode。
 *
 * 'default' → 'active'（新成员语义；与 DB DEFAULT 'active' 保持一致）。
 * @@@5856 档位收成两档后，历史值 'adaptive' 就是今天的 'active'（同一个行为改了个名字），
 * 所以它**不是**非法值，要原样接住 —— 老设备、老蓝图、离线队列里都还躺着这个字符串，
 * 把它判成非法会在 dev 里炸、在 prod 里被当成未知值。
 */
export function resolveListenModeDefault(raw: string | null | undefined): ListenMode {
  if (!raw || raw === 'default' || raw === 'adaptive') return 'active'
  if (raw === 'passive' || raw === 'active') return raw
  // 未知值 fallback 到 active（保守选择）。@@@1680 - 一个非空但非法的 listen_mode 值 = 真 bug（DB CHECK
  // 本应挡住），不是合法默认；dev/test 下 fail loud，prod 仍保守落 active。
  failLoudInDev(`resolveListenModeDefault unknown listen_mode value ${JSON.stringify(raw)}`)
  return 'active'
}
