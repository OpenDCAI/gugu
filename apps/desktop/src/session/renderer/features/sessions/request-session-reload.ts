import { invokeOnMachine } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import {
  SESSIONPAGE_SESSION_RELOAD_CHANNEL,
  type SessionReloadReasonCode,
  type SessionReloadResponse,
} from '@/session/shared/core/agents/session-reload';

/**
 * 请主进程重开这条会话并续上历史。
 *
 * 调用前提:**新的选择已经落进会话记录**(模型 / MCP 开关)—— 这条通道不带注入内容,
 * 主进程按记录重算整份。顺序反了的话,重开出来的还是旧配置,而界面会说重开成功。
 *
 * 失败**原样**回原话,❌ 不在这里折成一句「重开失败」:「同工作区还有另一条会话attach在同一个
 * 适配器上」与「恢复原 provider 会话失败」是两种事故,用户的下一步不同 —— 折了之后界面上说的
 * 和什么都没说一样。
 *
 * #6264 会话在别的机器上:问那台机器(会话记录与进程都在那边,由它的主进程应答,见 device-session-host.ts 的兜底)。
 */
export async function requestSessionReload(input: {
  sessionId: string;
  reason: SessionReloadReasonCode;
  /** 要换成的模型(裸 id);由宿主先写进会话记录再重开,见契约里那条注释。 */
  model?: string;
  /** 要关掉的那几台 MCP server;⚠️ 空数组有意义,见契约。 */
  mcpDisabledServers?: readonly string[];
  /** 新模型走哪条计费路 —— 与 `model` 同进同出,少了它重开会带着旧的那条路重来。 */
  modelSource?: 'platform' | 'own';
  /** 思考档位:字符串换档 / `null` 回默认 / 省略不碰(见契约)。 */
  effort?: string | null;
}): Promise<SessionReloadResponse> {
  const machine = machineRegistry.machineOf(input.sessionId);
  const response = (await invokeOnMachine(machine, SESSIONPAGE_SESSION_RELOAD_CHANNEL, {
    sessionId: input.sessionId,
    reason: input.reason,
    ...(input.model ? { model: input.model, modelSource: input.modelSource } : {}),
    // `null` 有意义(回默认),所以判的是在场,❌ 不是真值。
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    // ⚠️ 用 `Array.isArray` 判在场,**不是真值判断** —— `[]` 是真值没错,但更要紧的是
    //    这里若写成 `input.mcpDisabledServers?.length ? …`,空数组就会被丢掉,
    //    而「用户把开关全打开又确认」正好产出空数组:这个明确决定仍须落库。
    ...(Array.isArray(input.mcpDisabledServers)
      ? { mcpDisabledServers: input.mcpDisabledServers }
      : {}),
  })) as unknown;
  // 形状不对当成失败,并把拿到的东西说出来 —— ❌ 不默认成功:一个读不懂的回包被当成 ok,
  // 就是「界面说重开完了、实际什么都没发生」。
  if (!response || typeof response !== 'object' || typeof (response as { ok?: unknown }).ok !== 'boolean') {
    return { ok: false, error: `unrecognized reload response: ${JSON.stringify(response)}` };
  }
  return response as SessionReloadResponse;
}
