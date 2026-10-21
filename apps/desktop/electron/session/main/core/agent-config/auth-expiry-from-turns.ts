/**
 * #6264 会话的结局 → 这家 harness 在这台机器上「登录已失效」标记的增减。
 *
 * 判据只有两条,都读 session-runtime 已经分类好的回合终局(❌ 不在这里再看错误原文):
 *  · 这一轮因鉴权被拒(`outcome.signInRequired`)⇒ 标上;
 *  · 这一轮正常做完(`done`)⇒ 这家现在能用,撤掉(本来没标就是空操作)。
 * 取消、其它失败、重放回来的旧回合、更早那一轮被补内容(`backfill`,#6582)都不动它 —— 旧回合说的是过去,
 * ❌ 拿它改现在的状态。
 * 跑咕咕平台模型的会话也不动它:那时用的是咕咕签的凭据,成败与用户自己那份登录无关
 * (平台那边 401 ❌ 把用户的 codex 说成失效;平台模型跑通 ❌ 把失效的登录说成好了)。
 *
 * 纯函数;真正去改标记的是 `applyTurnToAuthExpiry`(写入方注入,见下)。
 */
import type { TranscriptTurn } from '@gugu/session-core/acp';

export type AuthExpiryEffect = { kind: 'mark' | 'clear'; providerId: string } | null;

export function authExpiryEffect(event: {
  providerId?: string;
  sessionId?: string;
  platformCredentials?: boolean;
  source: 'live' | 'replay' | 'revision' | 'backfill';
  turn: Pick<TranscriptTurn, 'outcome'>;
}): AuthExpiryEffect {
  const providerId = event.providerId;
  if (!providerId || event.source === 'replay' || event.source === 'backfill' || event.platformCredentials) return null;
  const outcome = event.turn.outcome;
  if (!outcome) return null;
  if (outcome.kind === 'error' && outcome.signInRequired) return { kind: 'mark', providerId };
  if (outcome.kind === 'done' && event.source === 'live') return { kind: 'clear', providerId };
  return null;
}

export type AuthExpiryWriter = {
  mark(providerId: string, sessionId?: string): Promise<void>;
  clear(providerId: string, sessionId?: string): Promise<void>;
  log(message: string, detail: Record<string, unknown>): void;
};

/** 把一条回合的结局落到标记上。写失败只记日志 —— ❌ 冒到会话那一侧(那会把一次状态写失败升级成会话出错)。 */
export function applyTurnToAuthExpiry(
  event: Parameters<typeof authExpiryEffect>[0],
  writer: AuthExpiryWriter
): Promise<void> | null {
  const effect = authExpiryEffect(event);
  if (!effect) return null;
  const run = effect.kind === 'mark' ? writer.mark(effect.providerId, event.sessionId) : writer.clear(effect.providerId, event.sessionId);
  return run.catch((error) => {
    writer.log('auth expiry update failed', { providerId: effect.providerId, effect: effect.kind, error: String(error) });
  });
}

// ── 「编程」(终端)会话这条腿 ───────────────────────────────────────────────────

/**
 * #6264 终端会话里的登录被拒同样回写「登录已失效」。终端会话没有结构化的回合终局,只有 harness 自己的钩子:
 * Claude Code 的 StopFailure 带 `error: authentication_failed`(见 claude/hooks.ts)⇒ 标上;
 * 一轮正常结束(Stop)⇒ 撤掉(本来没标就是空操作)。跑咕咕平台模型的会话不动它 —— 理由同 `authExpiryEffect`。
 */
export function hookAuthExpiryEffect(event: {
  providerId?: string;
  sessionId?: string;
  type: string;
  signInRequired?: boolean;
  platformCredentials: boolean;
}): AuthExpiryEffect {
  if (!event.providerId || event.platformCredentials) return null;
  if (event.type === 'error' && event.signInRequired) return { kind: 'mark', providerId: event.providerId };
  if (event.type === 'stop') return { kind: 'clear', providerId: event.providerId };
  return null;
}

/**
 * 这条终端会话此刻是不是跑在咕咕平台模型上。答案在宿主那边(平台令牌的持有表),由宿主注入 ——
 * ❌ 会话页相对 import 宿主模块(跨 bundle 只会拿到一份读不到的复制品,同 setLoginShellEnvProvider)。
 * 没注入 = 当作「是」:宁可不学,❌ 把平台那边的 401 说成用户自己的登录失效。
 */
let platformCredentialsProbe: ((sessionId: string) => boolean) | null = null;

export function setPlatformCredentialsProbe(fn: ((sessionId: string) => boolean) | null): void {
  platformCredentialsProbe = fn;
}

export function sessionUsesPlatformCredentials(sessionId: string): boolean {
  return platformCredentialsProbe ? platformCredentialsProbe(sessionId) : true;
}

/** 把一条钩子事件落到标记上。写失败只记日志(同 applyTurnToAuthExpiry)。 */
export function applyHookToAuthExpiry(
  event: Parameters<typeof hookAuthExpiryEffect>[0],
  writer: AuthExpiryWriter
): Promise<void> | null {
  const effect = hookAuthExpiryEffect(event);
  if (!effect) return null;
  const run = effect.kind === 'mark' ? writer.mark(effect.providerId, event.sessionId) : writer.clear(effect.providerId, event.sessionId);
  return run.catch((error) => {
    writer.log('auth expiry update from hook failed', { providerId: effect.providerId, effect: effect.kind, error: String(error) });
  });
}
