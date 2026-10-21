import type { ReactNode } from 'react';
import { FileQuestion } from '@/lib/icons'
import { useSessionMessages } from '@renderer/localization/use-session-messages';

interface BinaryRendererProps {
  file: { path: string };
  /** 卡片底下的动作(别的机器上的文件:「改成下载到这台电脑」)。 */
  action?: ReactNode;
}

/** Shown for binary or otherwise unsupported files. */
export function BinaryRenderer({ file, action }: BinaryRendererProps) {
  const { translate } = useSessionMessages();
  const fileName = file.path.split('/').pop() ?? file.path;
  const ext = file.path.split('.').pop()?.toUpperCase();

  return (
    <div className="text-foreground-muted flex h-full flex-col items-center justify-center gap-3">
      <FileQuestion className="h-10 w-10 opacity-30" />
      <div className="text-center">
        <p className="text-sm font-medium">{fileName}</p>
        {ext && <p className="mt-0.5 text-xs opacity-50">{ext} file</p>}
        <p className="mt-1 text-xs opacity-70">{translate('task.unsupportedFileFormat')}</p>
        {action}
      </div>
    </div>
  );
}
