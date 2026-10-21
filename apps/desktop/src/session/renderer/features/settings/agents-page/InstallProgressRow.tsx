import { useState } from 'react';
import type { AgentInstallProgress } from '@gugu/session-core/workspace-server';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { installProgressLine } from './install-progress-line';

/**
 * 安装进行中那一格：一句「在干什么、到哪了、多快、还要多久」＋ 取消 ＋ 一条进度条。
 *
 * 单独成件有两个理由，都不是为了好看：
 * - **只在装的时候挂载**，所以「已经按过取消」这一格状态随每次安装重新开始。挂在卡片上时它
 *   永不复位 —— 取消过一次之后再装，取消按钮就一直是灰的。
 * - 条子的**实际宽度**是这一格唯一能判真假的东西，而它只在真排版之后才存在；单独成件才能
 *   在真浏览器里把它量出来（tests/browser/agents-install-progress-5719.test.tsx）。
 */
export function InstallProgressRow({
  progress,
  onCancel,
}: {
  progress: AgentInstallProgress | null;
  onCancel: () => void;
}) {
  const { translate } = useSessionMessages();
  const [cancelRequested, setCancelRequested] = useState(false);
  const line = installProgressLine(progress, translate);

  return (
    <>
      <div className="flex min-h-9 items-center gap-3">
        {/* 实测读数优先；这一拍还没有读数时才退回那句「装到咕咕自己的目录」。
            ❌ 不给一个「正在安装…」了事 —— 那正是 owner 说的「提心吊胆，等半天」。 */}
        <p className="min-w-0 text-xs/5 text-foreground-muted">
          {line?.text ?? translate('agentsPage.installingToGuguHome')}
        </p>
        {/* 能等就能取消（product spec）。按下之后立刻禁用，
            因为中止是一趟往返，重复按只会发第二条没用的请求。 */}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto shrink-0"
          disabled={cancelRequested}
          onClick={() => {
            setCancelRequested(true);
            onCancel();
          }}
        >
          {translate('agentsPage.installCancel')}
        </Button>
      </div>
      <div
        data-testid="install-progress-track"
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-background-2"
      >
        {/* 有分母才画定长条。拿不到分母时保持不定长动画 —— ❌ 不拿估算值凑一条假的。 */}
        {line !== null && line.ratio !== null ? (
          <span
            data-testid="install-progress-determinate"
            className="block h-full bg-foreground-info transition-[width] duration-500 motion-reduce:transition-none"
            style={{ width: `${Math.round(line.ratio * 100)}%` }}
          />
        ) : (
          <span
            data-testid="install-progress-indeterminate"
            className="gg-progress-indeterminate block h-full w-[38%] bg-foreground-info"
          />
        )}
      </div>
    </>
  );
}
