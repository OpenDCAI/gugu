import { AcpStartError } from '@renderer/lib/acp/acp-live-session';

export type AcpLoadError =
  | { kind: 'auth_required'; message: string }
  | { kind: 'adapter_lost'; message: string }
  | { kind: 'provider_session_missing'; message: string }
  | { kind: 'harness_not_installed'; message: string }
  /**
   * #5173 — the harness is on disk but mid-replacement (a self-update or reinstall), so
   * `which` refuses it for the few seconds the package manager needs. Unlike
   * `harness_not_installed` this **is** retryable: nothing is missing and no user action
   * repairs it faster than waiting. Keeping the two apart is the whole point — the install
   * prompt is the wrong instruction for a harness that is already installed.
   */
  | { kind: 'harness_updating'; message: string }
  /**
   * #5047 — the model chosen in the composer cannot be applied on this provider connection
   * (runtime `set_config_failed` at start). `message` is the runtime's sentence: provider,
   * chosen model id, and the provider's own reason verbatim. The exit is a new session on a
   * model the provider can run (the Gugu-provided group), so the panel keeps this out of the
   * generic "failed to load" copy.
   */
  | { kind: 'model_unavailable'; message: string }
  /**
   * 这一家的版本低于这一版客户端要的下界(#6341 的同一件事,聊天腿)。两个数由运行时原样带过来
   * (`source.ts` 把它们放在 spawn_failed 的 `cause.data`);界面照终端腿那份提示说,给更新入口与重试。
   */
  | { kind: 'runtime_upgrade'; message: string; installedVersion: string; supportedFloor: string }
  | { kind: 'generic'; message: string };

/**
 * 这些失败重试也没用：装不上的 harness 要用户先装。retry() 与 remount 之类的通用重试调用方
 * 都必须在它们面前停住，否则就是把一次失败变成一轮 respawn 风暴。
 * （#4277 曾在这里多一格「会话属于别的账号」；主修后会话不带账号，那条错在启动路径上无处触发。）
 *
 * ⚠️ @@@5173 `harness_updating` **不**在此列。这个判定原本写的是「引擎缺失不可能自愈」，
 * 而正在被替换的那一种十秒后就自愈了 —— 分类过宽,把一个暂时态判成了终态,于是聊天腿上
 * 那条会话永远点不开。判据是引擎**还在不在盘上**,不是它此刻能不能跑。
 */
export function isTerminalLoadError(error: AcpLoadError | null | undefined): boolean {
  if (!error) return false;
  return error.kind === 'harness_not_installed';
}

// @@@fail-loud error text (#4657) — 任何到达用户的错误文案都必须携带可归因的真因。
// 结构化错误(BaseError/RPC error)按 message → cause 链 → type → JSON 逐级取真话,
// 不存在压成通用兜底串的路径。cause 链深度有界,防循环引用。
const MAX_CAUSE_DEPTH = 5;

function errorText(error: unknown, depth = 0): string {
  if (error instanceof Error) return error.message || String(error);
  if (typeof error === 'object' && error !== null) {
    const { message, type, cause } = error as {
      message?: unknown;
      type?: unknown;
      cause?: unknown;
    };
    if (typeof message === 'string' && message) return message;
    const tag = typeof type === 'string' && type ? type : undefined;
    if (cause !== undefined && cause !== null && depth < MAX_CAUSE_DEPTH) {
      const causeText = errorText(cause, depth + 1);
      return tag ? `${tag}: ${causeText}` : causeText;
    }
    if (tag) return tag;
    try {
      const json = JSON.stringify(error);
      if (json && json !== '{}') return json;
    } catch {
      // 不可序列化(循环引用等)——落到下面的 String(error),仍然不是通用文案
    }
  }
  return String(error);
}

export function resultError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorText(error));
}

export function toLoadError(error: unknown): AcpLoadError {
  const message = errorText(error);
  if (error instanceof AcpStartError && error.errorType === 'auth_required') {
    return { kind: 'auth_required', message };
  }
  if (error instanceof AcpStartError && error.errorType === 'provider_session_missing') {
    return { kind: 'provider_session_missing', message };
  }
  if (error instanceof AcpStartError && error.errorType === 'set_config_failed') {
    return { kind: 'model_unavailable', message };
  }
  const cause = error instanceof AcpStartError ? error.runtimeError.cause : undefined;
  const upgrade = cause && typeof cause === 'object' && (cause as { code?: unknown }).code === 'runtime-version-unsupported'
    ? (cause as { data?: { installedVersion?: unknown; supportedFloor?: unknown } }).data
    : undefined;
  if (
    error instanceof AcpStartError
    && error.errorType === 'spawn_failed'
    && typeof upgrade?.installedVersion === 'string'
    && typeof upgrade.supportedFloor === 'string'
  ) {
    return { kind: 'runtime_upgrade', message, installedVersion: upgrade.installedVersion, supportedFloor: upgrade.supportedFloor };
  }
  if (
    error instanceof AcpStartError
    && error.errorType === 'spawn_failed'
    && cause
    && typeof cause === 'object'
    && (
      (cause as { name?: unknown }).name === 'HarnessUpdatingError'
      // `name` does not survive the runtime re-wrap on the way here, so the minted message is
      // the arm that actually fires. It must stay in step with HarnessUpdatingError's prefix.
      || /\bis updating:/i.test((cause as { message?: unknown }).message as string ?? '')
    )
  ) {
    return { kind: 'harness_updating', message };
  }
  if (
    error instanceof AcpStartError
    && error.errorType === 'spawn_failed'
    && cause
    && typeof cause === 'object'
    && (
      (cause as { name?: unknown }).name === 'HarnessNotInstalledError'
      || /\bnot installed:/i.test((cause as { message?: unknown }).message as string ?? '')
    )
  ) {
    return { kind: 'harness_not_installed', message };
  }
  return { kind: 'generic', message };
}
