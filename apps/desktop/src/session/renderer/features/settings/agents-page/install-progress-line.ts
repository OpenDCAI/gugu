import type { AgentInstallProgress } from '@gugu/session-core/workspace-server';
import { formatBytes } from '@renderer/utils/formatBytes';
import type { useSessionMessages } from '@renderer/localization/use-session-messages';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

const PHASE_KEYS = {
  starting: 'agentsPage.phaseStarting',
  resolving: 'agentsPage.phaseResolving',
  downloading: 'agentsPage.phaseDownloading',
  installing: 'agentsPage.phaseInstalling',
  verifying: 'agentsPage.phaseVerifying',
} as const;

/**
 * 进度的比例 —— **没有分母就是 null**。
 *
 * 一处定义,两处画:面板下半格那条横条与图标网格上那圈环(#6157)。
 * ❌ 别在环那边另算一次:凑一个估算百分比正是 product spec 的禁令,
 * 而两处各写一份的那一刻,其中一处就会开始凑。
 */
export function installProgressRatio(progress: AgentInstallProgress | null): number | null {
  if (!progress) return null;
  const done = progress.bytesDone ?? 0;
  return progress.bytesTotal && done > 0 ? Math.min(1, done / progress.bytesTotal) : null;
}

export type InstallProgressLine = {
  /** 一行说清「在干什么、到哪了、多快、还要多久」。 */
  text: string;
  /** 0–1；**没有分母时是 null**，调用方据此画不定长条，❌ 不许自己凑一个比例。 */
  ratio: number | null;
};

/**
 * 把一条实时读数翻成界面上那一行字。
 *
 * 判据（product spec）：
 * - 有分母 → 「已完成 / 总共 · 速度 · 剩余」，并给出真实比例；
 * - 没有分母 → **只报已完成量与速度**，比例返回 null；❌ 不展示估算出来的百分比。
 * - 一个字节都还没落地 → 只说阶段。此时报「0 B · 0 B/s」只会让人以为卡住了。
 */
export function installProgressLine(
  progress: AgentInstallProgress | null,
  translate: Translate
): InstallProgressLine | null {
  if (!progress) return null;
  const parts: string[] = [translate(PHASE_KEYS[progress.phase])];
  // 一次装几个程序时(#6335)先说是哪一个 —— 后面的字节与比例只属于它,换到下一个时条子从头走,
  // 不带这一格,用户看到的是「进度倒退了」。名字是 provider 数据,只做插值。
  if (progress.part) {
    parts.unshift(`${progress.part.name} ${progress.part.index}/${progress.part.count}`);
  }

  const done = progress.bytesDone ?? 0;
  if (done > 0) {
    parts.push(
      progress.bytesTotal
        ? `${formatBytes(done)} / ${formatBytes(progress.bytesTotal)}`
        : formatBytes(done)
    );
  }
  if (progress.bytesPerSecond) parts.push(`${formatBytes(progress.bytesPerSecond)}/s`);
  if (progress.etaSeconds !== undefined) {
    parts.push(
      progress.etaSeconds >= 60
        ? translate('agentsPage.installEtaMinutes', {
            minutes: Math.round(progress.etaSeconds / 60),
          })
        : translate('agentsPage.installEtaSeconds', { seconds: progress.etaSeconds })
    );
  }

  return { text: parts.join(' · '), ratio: installProgressRatio(progress) };
}
