import type { HarnessPresence, HarnessPresenceFile, HarnessPresenceStatus } from '@gugu/session-core/agents/plugins';

/**
 * Claude Code 为每个交互进程写的会话在场记录:`<配置目录>/sessions/<pid>.json`(它自己的 agents 视图与
 * 跨会话消息读的就是它;带 `peerProtocol`)。`status` 由界面的真实状态算出:等对话框 / 提问 = `waiting`,
 * 在跑 = `busy`,后台命令还在跑 = `shell`,否则 `idle`。
 *
 * 实测(gugu-base notes/2026-10-16-osc-7501/rendezvous-presence/):daemon 模式(咕咕的投递方式)下照样写;
 * Esc 后约 0.2 s 变 `idle`。带 `statusUpdatedAt` 的 status 2.1.175 起有(2.1.150 没有)。没有文档 ⇒
 * 解析只认已知的形状,别的一律抛(协议变了要响亮,❌ 猜)。
 */
export const CLAUDE_PRESENCE_SINCE = '2.1.175';

const STATUSES: ReadonlySet<string> = new Set<HarnessPresenceStatus>(['busy', 'idle', 'waiting', 'shell']);

function parseClaudePresence(text: string): HarnessPresence {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`claude session presence is not JSON: ${String(error)}`);
  }
  if (!value || typeof value !== 'object') throw new Error('claude session presence is not an object');
  const record = value as Record<string, unknown>;
  const { pid, sessionId, status } = record;
  if (typeof pid !== 'number' || !Number.isInteger(pid)) throw new Error('claude session presence carries no pid');
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('claude session presence carries no sessionId');
  if (typeof status !== 'string') throw new Error('claude session presence carries no status');
  if (!STATUSES.has(status)) throw new Error(`claude session presence status "${status}" is not one gugu knows`);
  return { pid, sessionId, status: status as HarnessPresenceStatus };
}

export const claudePresenceFile: HarnessPresenceFile = {
  configDirEnvVar: 'CLAUDE_CONFIG_DIR',
  defaultConfigDirName: '.claude',
  directory: 'sessions',
  parse: parseClaudePresence,
};
