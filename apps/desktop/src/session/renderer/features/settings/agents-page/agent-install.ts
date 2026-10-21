import { match } from 'ts-pattern';
import type { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AgentInstallError, AgentUpdateError } from '@shared/core/agents/agent-payload';

export type AgentInstallErrorPresentation = {
  message: string;
  diagnostic: string | null;
};

/**
 * npm 的进度条画的是**盲文点阵**(U+2800–U+28FF)，不是控制字符也不是 ANSI 序列，
 * 所以上面两条清洗一个都盖不住它 —— 真实现场里用户看到的是一屏 `⣿⣿⣿…` 顶着
 * `npm error code EEXIST`，真正的原因被挤到看不见的地方。
 */
const SPINNER_GLYPHS = /[\u2800-\u28ff]+/g;

function sanitizeCommandOutput(output: string): string {
  return output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(SPINNER_GLYPHS, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/[^\S\n]{2,}/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/** 够用来回答「那个路径上是谁」的最小形状；`Installation` 天然满足。 */
export type OccupantCandidate = {
  realpath: string;
  pathEntry: string | null;
  version: string | null;
  provenance: { kind: string };
};

const METHOD_LABELS: Record<string, string> = {
  npm: 'npm',
  homebrew: 'Homebrew',
  go: 'go',
  curl: 'a script install',
  'version-manager': 'a version manager',
  manual: 'a manual install',
};

/**
 * npm 装 -g 时若要写的 bin 链接已经被一个**不属于它**的文件占着，就报 EEXIST 并把那个路径
 * 写在 `npm error path`。这不是网络问题也不是权限问题，重试一百次都是同一个结果 —— 所以要把
 * 路径挖出来,好让上层能回答「谁占着」。拿不准就返回 null:宁可不解释,也不瞎猜一个路径。
 */
export function npmBlockedBinPath(output: string): string | null {
  const clean = sanitizeCommandOutput(output);
  if (!/\bEEXIST\b/.test(clean)) return null;
  const raw =
    clean.match(/npm error path (\S+)/)?.[1] ?? clean.match(/File exists:\s*(\S+)/)?.[1] ?? null;
  const path = raw?.trim();
  if (!path) return null;
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : null;
}

function occupiedBinPathPresentation(
  path: string,
  output: string | undefined,
  context: InstallFailureContext | undefined,
): AgentInstallErrorPresentation {
  const diagnostic = output ? sanitizeCommandOutput(output) : null;
  // 只有能在枚举到的副本里认出占位者时才点名 —— 认不出就照实说「不是 npm 的文件」，
  // ❌ 不编造一个来源。
  const occupant = context?.installations?.find(
    (i) => i.realpath === path || i.pathEntry === path,
  );
  if (!occupant) {
    return {
      message: copy(context?.translate, 'agentsPage.errBinPathTakenByUnknown', { path }),
      diagnostic,
    };
  }
  const method = METHOD_LABELS[occupant.provenance.kind] ?? occupant.provenance.kind;
  const who = occupant.version ? `${method} v${occupant.version}` : method;
  return {
    message: copy(context?.translate, 'agentsPage.errBinPathTakenByKnown', { path, who }),
    diagnostic,
  };
}

function commandFailurePresentation(
  message: string,
  output?: string,
  facts?: {
    stage?: string;
    artifacts?: Array<{ path: string; bytes: number | null }>;
  },
): AgentInstallErrorPresentation {
  const diagnosticParts = output ? [sanitizeCommandOutput(output)] : [];
  if (facts?.stage) diagnosticParts.unshift(`Failed at stage: ${facts.stage}`);
  for (const artifact of facts?.artifacts ?? []) {
    const size = artifact.bytes === null ? 'size unavailable' : `${artifact.bytes} bytes`;
    diagnosticParts.push(`Partial install remains at ${artifact.path} (${size}).`);
  }
  const diagnostic = diagnosticParts.length ? diagnosticParts.join('\n\n') : null;
  const lines = diagnostic?.split(/\n|\s{2,}/).map((line) => line.trim()).filter(Boolean) ?? [];
  const specificCause = lines.find(
    (line) =>
      /\b(?:E[A-Z][A-Z0-9_]+|ECONNRESET)\b/.test(line) ||
      /network aborted|timed out/i.test(line),
  );
  const genericCause = lines.find((line) => /failed|error/i.test(line));
  const cause = specificCause ?? genericCause ?? lines[0];
  return { message: cause ? `${message}: ${cause}` : message, diagnostic };
}

/**
 * 文案在渲染层按错误的**类型**写,不转发主进程那边的英文 `message` —— 主进程负责事实,
 * 渲染层负责措辞。`translate` 缺省时退回英文,好让还没接上 i18n 的调用方和单测照常工作。
 */
export type Translate = ReturnType<typeof useSessionMessages>['translate'];
type MessageKey = Parameters<Translate>[0];

/** 本机枚举到的副本；给了才可能点名占位者。 */
export type InstallFailureContext = {
  installations?: readonly OccupantCandidate[];
  translate?: Translate;
};

const FALLBACK_COPY: Partial<Record<MessageKey, string>> = {
  'agentsPage.errPermissionDenied': 'Not enough permission to run that command.',
  'agentsPage.errCommandFailed': 'The command failed',
  'agentsPage.errPtyOpenFailed': 'Could not open a terminal to run the command: {detail}',
  'agentsPage.errUnsupportedHost':
    'Gugu cannot install this one here. Install it yourself, then pick that copy above.',
  'agentsPage.errUnknownDependency': 'Unknown dependency: {id}',
  'agentsPage.errNoInstallCommand': 'No install command is available for {id} on this platform.',
  'agentsPage.errNoUpdateStrategy': 'No update method is available for {id}.',
  'agentsPage.errInstallCancelled':
    'Install cancelled. A partial install may remain on disk; installing again overwrites it.',
  'agentsPage.errInstallStalled':
    'The install made no progress for {minutes} min and was stopped. Check the network connection and try again.',
  'agentsPage.errNotDetectedAfterInstall':
    'The command finished, but the agent still cannot be found.',
  'agentsPage.errNotDetectedAfterUpdate':
    'The command finished, but the agent still cannot be found.',
  'agentsPage.errVersionUnchanged':
    'The command finished, but v{version} is still what runs ({path}) — the new version landed somewhere else.',
  'agentsPage.errBinPathTakenByKnown':
    '{path} already holds another copy ({who}). npm will not overwrite a file it does not own, so retrying cannot help. Pick that copy under "Change source", or remove it and try again.',
  'agentsPage.errBinPathTakenByUnknown':
    '{path} holds a file npm does not own, so it will not overwrite it and retrying cannot help. Remove that file, or install from a different source.',
};

function copy(
  translate: Translate | undefined,
  key: MessageKey,
  params: Record<string, string | number> = {},
): string {
  if (translate) return translate(key, params);
  return Object.entries(params).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    FALLBACK_COPY[key] ?? String(key),
  );
}

export function getAgentInstallErrorPresentation(
  error: AgentInstallError,
  context?: InstallFailureContext,
): AgentInstallErrorPresentation {
  const t = context?.translate;
  return match(error)
    .with({ type: 'permission-denied' }, (e) =>
      e.stage || e.artifacts?.length
        ? commandFailurePresentation(copy(t, 'agentsPage.errPermissionDenied'), e.output, e)
        : { message: copy(t, 'agentsPage.errPermissionDenied'), diagnostic: null },
    )
    .with({ type: 'command-failed' }, (e) => {
      const blocked = npmBlockedBinPath(e.output);
      return blocked
        ? occupiedBinPathPresentation(blocked, e.output, context)
        : commandFailurePresentation(copy(t, 'agentsPage.errCommandFailed'), e.output, e);
    })
    .with({ type: 'cancelled' }, (e) =>
      commandFailurePresentation(copy(t, 'agentsPage.errInstallCancelled'), e.output, e),
    )
    .with({ type: 'stalled' }, (e) =>
      commandFailurePresentation(
        copy(t, 'agentsPage.errInstallStalled', {
          minutes: Math.round(e.idleMs / 60_000),
        }),
        e.output,
        e,
      ),
    )
    .with({ type: 'pty-open-failed' }, (e) => ({
      message: copy(t, 'agentsPage.errPtyOpenFailed', { detail: e.message }),
      diagnostic: null,
    }))
    // 这儿装不了 —— 一条命令都没跑,所以没有 diagnostic 可给(#6098)。
    .with({ type: 'unsupported-host' }, () => ({
      message: copy(t, 'agentsPage.errUnsupportedHost'),
      diagnostic: null,
    }))
    .with({ type: 'unknown-dependency' }, (e) => ({
      message: copy(t, 'agentsPage.errUnknownDependency', { id: e.id }),
      diagnostic: null,
    }))
    .with({ type: 'no-install-command' }, (e) => ({
      message: copy(t, 'agentsPage.errNoInstallCommand', { id: e.id }),
      diagnostic: null,
    }))
    .with({ type: 'not-detected-after-install' }, () => ({
      message: copy(t, 'agentsPage.errNotDetectedAfterInstall'),
      diagnostic: null,
    }))
    .exhaustive();
}

/** MutationCache 里一次安装的残留:变量、结果、抛出的异常、发起时刻。 */
export type SettledInstallEntry = {
  vars: { id: string } | undefined;
  data: { success: true } | { success: false; error: AgentInstallError | AgentUpdateError } | undefined;
  error: Error | null | undefined;
  submittedAt: number;
};

/**
 * 从 MutationCache 的残留里挑出**这个 agent** 最近一次安装失败的说法。
 *
 * 三件事都是踩过的:
 * - 按 `vars.id` 过滤 —— 不过滤就会把别的 agent 的报错顶到这张卡上(缓存是整台机器共用的)。
 * - RPC 失败是**已完成的 mutation 返回 `success: false`**,不是 throw;两种都要收,只收一种
 *   会让最常见的那类失败(命令跑了但退出码非零)静默消失。
 * - 正在装时返回 null —— 重试期间不该还挂着上一次的报错。
 */
function lastSettledFor(
  entries: readonly SettledInstallEntry[],
  agentId: string,
): SettledInstallEntry | undefined {
  return entries
    .filter((e) => e.vars?.id === agentId && (e.data !== undefined || e.error))
    .sort((a, b) => a.submittedAt - b.submittedAt)
    .at(-1);
}

/**
 * 这个 agent 最近一次**成功**安装的发起时刻,没有则 null。
 *
 * 给「刚装好」用:装完卡片会从「还没有装」翻成「咕咕安装的 v…」,但版本号对第一次装的人不构成
 * 确认 —— 他不知道那个数字本来是什么。所以短暂地把「这是你刚才那一下的结果」说出来。
 */
export function pickLastInstallSuccessAt(
  entries: readonly SettledInstallEntry[],
  agentId: string,
): number | null {
  const last = lastSettledFor(entries, agentId);
  return last && !last.error && last.data?.success === true ? last.submittedAt : null;
}

export function pickLastInstallError(
  entries: readonly SettledInstallEntry[],
  agentId: string,
  isInstalling: boolean,
  context?: InstallFailureContext,
): AgentInstallErrorPresentation | null {
  return pickLastFailure(entries, agentId, isInstalling, (error) =>
    getAgentInstallErrorPresentation(error as AgentInstallError, context),
  );
}

/**
 * 最近一次**更新**失败的说法(#6101)。
 *
 * 与安装那条同一个挑法、同一套残留 —— 更新失败从前只有一条 6 秒的 toast:用户走开一会儿
 * 回来,界面显示「什么都没干过」,而日志里也一个字都没有。⇒ 同一格里留住它,直到下一次尝试。
 */
export function pickLastUpdateError(
  entries: readonly SettledInstallEntry[],
  agentId: string,
  isUpdating: boolean,
  context?: InstallFailureContext,
): AgentInstallErrorPresentation | null {
  return pickLastFailure(entries, agentId, isUpdating, (error) =>
    getAgentUpdateErrorPresentation(error as AgentUpdateError, context),
  );
}

function pickLastFailure(
  entries: readonly SettledInstallEntry[],
  agentId: string,
  busy: boolean,
  present: (error: unknown) => AgentInstallErrorPresentation,
): AgentInstallErrorPresentation | null {
  // 正在重试时不挂上一次的报错 —— 那会让用户以为新的这次已经失败了。
  if (busy) return null;
  const last = lastSettledFor(entries, agentId);
  if (!last) return null;
  if (last.error) return { message: last.error.message, diagnostic: null };
  if (last.data && last.data.success === false) return present(last.data.error);
  return null;
}

export type AgentUpdateActionState = {
  render: boolean;
  disabled: boolean;
  updating: boolean;
  label: string;
  versionLabel: string | null;
};

export function getAgentUpdateErrorPresentation(
  error: AgentUpdateError,
  context?: InstallFailureContext,
): AgentInstallErrorPresentation {
  const t = context?.translate;
  return match(error)
    .with({ type: 'permission-denied' }, (e) =>
      e.stage || e.artifacts?.length
        ? commandFailurePresentation(copy(t, 'agentsPage.errPermissionDenied'), e.output, e)
        : { message: copy(t, 'agentsPage.errPermissionDenied'), diagnostic: null },
    )
    .with({ type: 'command-failed' }, (e) => {
      const blocked = npmBlockedBinPath(e.output);
      return blocked
        ? occupiedBinPathPresentation(blocked, e.output, context)
        : commandFailurePresentation(copy(t, 'agentsPage.errCommandFailed'), e.output, e);
    })
    .with({ type: 'cancelled' }, (e) =>
      commandFailurePresentation(copy(t, 'agentsPage.errInstallCancelled'), e.output, e),
    )
    .with({ type: 'stalled' }, (e) =>
      commandFailurePresentation(
        copy(t, 'agentsPage.errInstallStalled', {
          minutes: Math.round(e.idleMs / 60_000),
        }),
        e.output,
        e,
      ),
    )
    .with({ type: 'pty-open-failed' }, (e) => ({
      message: copy(t, 'agentsPage.errPtyOpenFailed', { detail: e.message }),
      diagnostic: null,
    }))
    // 这儿装不了 —— 一条命令都没跑,所以没有 diagnostic 可给(#6098)。
    .with({ type: 'unsupported-host' }, () => ({
      message: copy(t, 'agentsPage.errUnsupportedHost'),
      diagnostic: null,
    }))
    .with({ type: 'unknown-dependency' }, (e) => ({
      message: copy(t, 'agentsPage.errUnknownDependency', { id: e.id }),
      diagnostic: null,
    }))
    .with({ type: 'no-update-strategy' }, (e) => ({
      message: copy(t, 'agentsPage.errNoUpdateStrategy', { id: e.id }),
      diagnostic: null,
    }))
    .with({ type: 'not-detected-after-update' }, () => ({
      message: copy(t, 'agentsPage.errNotDetectedAfterUpdate'),
      diagnostic: null,
    }))
    .with({ type: 'version-unchanged' }, (e) => ({
      message: copy(t, 'agentsPage.errVersionUnchanged', {
        version: e.version ?? '?',
        path: e.path ?? '?',
      }),
      diagnostic: e.path ? `${e.path} (v${e.version ?? '?'})` : null,
    }))
    .exhaustive();
}

export function getAgentUpdateActionState({
  updateAvailable,
  updateStrategyKind,
  version,
  latestVersion,
  isUpdating,
}: {
  updateAvailable: boolean;
  updateStrategyKind: string;
  version: string | null;
  latestVersion: string | null;
  isUpdating: boolean;
}): AgentUpdateActionState {
  const canUpdate = updateAvailable && updateStrategyKind !== 'none';
  const versionLabel = version && latestVersion ? `v${version} → v${latestVersion}` : null;

  return {
    render: canUpdate,
    disabled: isUpdating,
    updating: isUpdating,
    label: isUpdating ? 'Updating...' : 'Update',
    versionLabel,
  };
}
