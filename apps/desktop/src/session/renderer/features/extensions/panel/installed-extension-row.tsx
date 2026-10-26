import type { ExtensionProgramFailure } from '@shared/extensions/agent-status';
import { compareExtensionVersions } from '@shared/extensions/manifest';
import type { SessionTranslate } from '../extension-consent';

/**
 * 给 agent 的程序是怎么没起来的,用我们自己的话说(已安装那一行、产品页「给 agent 的工具」同一句);
 * 程序在 stderr 上的原话可能是一整段栈,不进文案(仓规 copy-leaks-internal-detail),放在悬停里。
 */
export function programFailureText(failure: ExtensionProgramFailure, translate: SessionTranslate): string {
  if (failure.kind === 'tool') return translate('appSettings.lastCallFailed');
  const what = failure.notStarted
    ? translate('extensions.agentProgramNotFound', { command: failure.command })
    : translate(failure.said ? 'extensions.agentProgramExitedSaid' : 'extensions.agentProgramExited', {
        code: String(failure.code ?? '?'),
      });
  return translate('extensions.agentProgramFailed', { what });
}

/**
 * 云端那口(`MarketUpdatesSummary`)对这一行要说的那句话(#5410)。三种形状分开带,
 * 而不是塞进一个「有话要说」布尔:每种都要求不同的一句文案和不同的按钮。
 */
export type InstalledRowNotice =
  | { kind: 'update'; version: string; releaseNotes: string }
  | { kind: 'yanked'; reason: string; installable: string | null }
  | { kind: 'deprecated'; note: string | null; replacedBy: string | null }
  | { kind: 'forkBehind'; upstream: string; behind: number; commit: string }
  | { kind: 'gone' };

/** 更新说明的第一行,去掉 Markdown 的列表点 / 标题井号 —— 一行里只放得下一句话。 */
function firstLine(markdown: string): string {
  const line = markdown.split(/\r?\n/).find((entry) => entry.trim() !== '')?.trim() ?? '';
  return line.replace(/^(?:[-*+]|\d+[.)]|#{1,6})\s+/, '');
}

/**
 * 一句话说清云端那口对这一行的判断(#5410),后面跟一个链接词当下一步:
 * 有新版 → 版本号 + 这版第一句 + 「更新到 vX」;这一版被撤回 → 原因(警示色,
 * 全页唯一一处),能换版本就给「更新到 vX」,换回更旧的一版就写「改用 vX」;已弃用 → 说明 + 「改用 X」。
 */
export function InstalledRowNoticeLine({
  notice,
  installedVersion,
  translate,
  onInstallVersion,
  onBrowseReplacement,
  onCopyForkPrompt,
}: {
  notice: InstalledRowNotice;
  installedVersion: string;
  translate: SessionTranslate;
  onInstallVersion?: (version: string) => void;
  onBrowseReplacement: () => void;
  onCopyForkPrompt?: () => void;
}) {
  if (notice.kind === 'forkBehind') {
    return (
      <span className="xp-note">
        <span>{translate('extensions.forkBehind', { version: notice.upstream, count: notice.behind })}</span>
        {onCopyForkPrompt && (
          <button type="button" className="xp-link" onClick={onCopyForkPrompt}>
            {translate('extensions.copyPrompt')}
          </button>
        )}
      </span>
    );
  }
  if (notice.kind === 'update') {
    const summary = firstLine(notice.releaseNotes);
    return (
      <span className="xp-note">
        <span>
          {translate('extensions.rowHasUpdate', { version: notice.version })}
          {summary && ` · ${summary}`}
        </span>
        {onInstallVersion && (
          <button type="button" className="xp-link" onClick={() => onInstallVersion(notice.version)}>
            {translate('extensions.updateTo', { version: notice.version })}
          </button>
        )}
      </span>
    );
  }
  if (notice.kind === 'yanked') {
    return (
      <span className="xp-note is-warn">
        <span>{translate('extensions.rowYanked', { note: notice.reason })}</span>
        {notice.installable && onInstallVersion && (
          <button
            type="button"
            className="xp-link"
            onClick={() => onInstallVersion(notice.installable!)}
          >
            {translate(
              compareExtensionVersions(notice.installable, installedVersion) < 0 ? 'extensions.useVersion' : 'extensions.updateTo',
              { version: notice.installable }
            )}
          </button>
        )}
      </span>
    );
  }
  if (notice.kind === 'gone') {
    return (
      <span className="xp-note">
        <span>{translate('extensions.rowGone')}</span>
      </span>
    );
  }
  return (
    <span className="xp-note">
      <span>{notice.note ?? translate('extensions.deprecated')}</span>
      {notice.replacedBy && (
        <button type="button" className="xp-link" onClick={onBrowseReplacement}>
          {translate('extensions.deprecatedUseReplacement', { name: notice.replacedBy })}
        </button>
      )}
    </span>
  );
}
