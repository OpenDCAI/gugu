import { Checkbox } from '@renderer/lib/ui/checkbox';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import {
  LOCAL_SESSION_ENGINE_LABEL,
  type LocalSessionRow,
} from '@shared/core/session-import/session-import';

/**
 * 路径只留末两级：一行里排得下、又足够认出是哪个仓；完整路径在 title 与右侧预览里。
 * 路径本身是原始数据，逐字保留；只有「压根没有路径」时才落到调用方传进来的本地化兜底标签。
 */
export function shortenPath(path: string | null, unknownLabel: string): string {
  if (!path) return unknownLabel;
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= 2) return path;
  return `…/${segments.slice(-2).join('/')}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 稳定的 option id —— 搜索框用 aria-activedescendant 指向它，读屏才播报得出选中项。
 * 按**文件路径**取（每行唯一）：同一个会话 id 可能出现在两个文件里（拷贝过的 transcript），
 * 用 sessionId 当身份会让两行同时高亮、而导入的却只是其中一条。
 */
export function sessionOptionId(filePath: string): string {
  return `import-session-option-${filePath}`;
}

export function SessionRow({
  session,
  isSelected,
  isChecked,
  onSelect,
  onToggle,
  onConfirm,
}: {
  session: LocalSessionRow;
  /** 光标位置：右侧预览显示的就是它，方向键移动的也是它。 */
  isSelected: boolean;
  /** 勾选状态：决定这条会不会被这次导入带上。 */
  isChecked: boolean;
  onSelect: () => void;
  onToggle: (event: React.MouseEvent) => void;
  onConfirm: () => void;
}) {
  const { translate } = useSessionMessages();
  return (
    <div
      id={sessionOptionId(session.filePath)}
      role="option"
      aria-selected={isSelected}
      tabIndex={-1}
      data-session-id={session.providerSessionId}
      data-file-path={session.filePath}
      data-checked={isChecked ? 'true' : 'false'}
      onClick={onSelect}
      onDoubleClick={onConfirm}
      // 三态走 @theme 里登记的 row-* 色标（见 index.css）：色值仍是 gugu 皮肤的交互 token，
      // 但走 Tailwind 工具类而不是手写 CSS 规则。方向键连按时渐变会把「选中的是哪条」糊成一片，
      // 所以 motion-reduce 下直接取消过渡。
      className="flex cursor-default items-start gap-2.5 px-3 py-2 transition-colors hover:bg-row-hover active:bg-row-press aria-selected:bg-row-selected motion-reduce:transition-none"
    >
      {/* 勾选框独立于行的点击：点行只是「看看这条」，勾选才决定导不导。
          两者分开，单条导入仍然是「点一下 + 回车」，不必先学会多选。 */}
      <Checkbox
        checked={isChecked}
        onClick={onToggle}
        aria-label={translate('sessionImport.selectSession', { title: session.title })}
        data-testid="import-session-checkbox"
        className="mt-1"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={session.title}>
          {session.title}
        </span>
        <RelativeTime
          value={session.updatedAt}
          compact
          className="shrink-0 text-xs text-foreground-tertiary-muted"
        />
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-foreground-muted">
        <span className="shrink-0">{LOCAL_SESSION_ENGINE_LABEL[session.engine]}</span>
        <span className="shrink-0 text-foreground-tertiary-muted">·</span>
        <span className="min-w-0 truncate" title={session.cwd ?? undefined}>
          {shortenPath(session.cwd, translate('sessionImport.unknownDirectory'))}
        </span>
        <span className="shrink-0 text-foreground-tertiary-muted">·</span>
        <span className="shrink-0 text-foreground-tertiary-muted">
          {formatSize(session.sizeBytes)}
        </span>
        </div>
      </div>
    </div>
  );
}
