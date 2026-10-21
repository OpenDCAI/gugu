import type { ReactNode } from 'react';
import { FileX } from '@/lib/icons'
import { EDITOR_HARD_MAX_FILE_BYTES } from '@renderer/lib/editor/file-size-limits';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { FileTabResource } from '@renderer/features/sessions/editor/stores/file-tab-resource';

interface TooLargeRendererProps {
  file: FileTabResource;
  /** 卡片底下的动作(别的机器上的文件:「改成下载到这台电脑」)。 */
  action?: ReactNode;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 文件超过「先问一句」那条线时顶上来的卡片。
 *
 * 它不是一堵墙:体积上限的含义是「默认不替你承担打开的代价」,而**只有用户知道这一次值不值**,
 * 所以这里给一个「仍然打开」,并把代价直说(慢、没有语法着色)。形态取自 VS Code —— 它同样
 * 弹一张警告占位卡,带「Open Anyway」，按下去用 `limits.size = Number.MAX_VALUE` 重开
 * (`microsoft/vscode` `src/vs/workbench/common/editor.ts` 的 `createTooLargeFileError`)。#5763
 *
 * 超过硬顶就不给按钮了 —— ❌ 一个按下去还是失败的按钮比不给更糟。
 */
export function TooLargeRenderer({ file, action }: TooLargeRendererProps) {
  const { translate } = useSessionMessages();
  const fileName = file.path.split('/').pop() ?? file.path;
  const size = file.totalSize;
  const withinHardLimit = size != null && size <= EDITOR_HARD_MAX_FILE_BYTES;
  const canOpenAnyway = withinHardLimit && file.canOpenAnyway;

  return (
    <div className="text-foreground-muted flex h-full flex-col items-center justify-center gap-3">
      <FileX className="h-10 w-10 opacity-30" />
      <div className="max-w-80 text-center">
        <p className="text-sm font-medium">{fileName}</p>
        <p className="mt-1 text-xs opacity-70">
          {size != null
            ? translate('task.fileLargeWithSize', { size: formatBytes(size) })
            : translate('task.fileTooLarge')}
        </p>
        <p className="mt-2 text-xs opacity-50">
          {withinHardLimit
            ? translate('task.fileLargeCost')
            : translate('task.fileBeyondHardLimit', {
                limit: formatBytes(EDITOR_HARD_MAX_FILE_BYTES),
              })}
        </p>
        {canOpenAnyway && (
          <button
            type="button"
            onClick={() => file.openAnyway()}
            className="mt-4 rounded-md border border-border-primary px-3 py-2 text-xs font-medium text-foreground-primary hover:bg-background-secondary-2"
          >
            {translate('task.openAnyway')}
          </button>
        )}
        {action}
      </div>
    </div>
  );
}
