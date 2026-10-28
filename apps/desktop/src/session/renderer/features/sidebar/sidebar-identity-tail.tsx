import { cn } from '@renderer/utils/utils';
import { splitPathTail } from './sidebar-identity-place';

/** 身份卡文件夹那一格:放不下时截前面、最后一段目录名整段露着(复制出去的仍是全路径,由行负责)。 */
export function TailValue({ text, className }: { text: string; className?: string }) {
  const { head, tail } = splitPathTail(text);
  return (
    <span className={cn('flex min-w-0 text-left text-sm leading-5', className)}>
      {head ? <span className="min-w-0 truncate">{head}</span> : null}
      {/* 结尾不参与收缩:只有它自己就比整格宽时才截(max-w-full)。❌ 靠收缩比例让前面先缩 —— 路径够长时两截
          一起被压,真机读成「~/Library/Applicat… /task-ho…」(1046.1 验收)。 */}
      <span className="max-w-full shrink-0 truncate">{tail}</span>
    </span>
  );
}
