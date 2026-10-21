import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { countOutcomes, type ImportOutcome } from './import-runner';
import { shortenPath } from './session-row';

/**
 * 批量导入的结果清单。
 *
 * 只报一句「导入完成」是不够的：批量里最常见的情况是**部分成功**，用户必须能看出
 * 哪几条没进来、为什么。所以成功的只给数字，失败的逐条列出来并带上原因。
 */
export function ImportSummary({ outcomes }: { outcomes: ImportOutcome[] }) {
  const { translate } = useSessionMessages();
  const counts = countOutcomes(outcomes);
  const failures = outcomes.filter((o) => o.kind === 'failed');

  // 每段都是能独立成句的完整子句，用 catalog 里的分隔符拼 —— 中英的顿号/逗号不同，
  // 把标点留在拼接处会让其中一种语言读起来是坏的。
  const segments = [
    translate('sessionImport.summaryImported', { count: counts.imported }),
    ...(counts.existing > 0
      ? [translate('sessionImport.summaryExisting', { count: counts.existing })]
      : []),
    ...(counts.failed > 0
      ? [translate('sessionImport.summaryFailed', { count: counts.failed })]
      : []),
  ];

  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="import-session-summary">
      <p className="text-sm text-foreground">
        {segments.join(translate('sessionImport.summarySeparator'))}
      </p>
      {failures.length > 0 ? (
        <div className="min-h-0 overflow-y-auto rounded-md border border-border">
          {failures.map((failure) => (
            <div
              key={failure.row.filePath}
              className="flex flex-col gap-0.5 px-3 py-2"
              data-testid="import-session-failure"
            >
              <span className="truncate text-sm text-foreground" title={failure.row.title}>
                {failure.row.title}
              </span>
              <span className="text-xs text-foreground-tertiary-muted">
                {shortenPath(failure.row.cwd, translate('sessionImport.unknownDirectory'))}
              </span>
              <span className="text-xs leading-relaxed text-foreground-destructive">
                {failure.message}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
