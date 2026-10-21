import { X } from '@/lib/icons'

interface ListFilterPillProps {
  label: string;
  avatarUrl?: string;
  color?: string;
  onRemove: () => void;
}

export function ListFilterPill({ avatarUrl, color, label, onRemove }: ListFilterPillProps) {
  // 胶囊档只给 switch / 头像 / 状态点 —— 筛选项是控件,落 sm(6px)。头像与色点本身仍是正圆。
  return (
    <span className="bg-background-2 inline-flex items-center gap-1 rounded-sm border border-border px-2 py-0.5 text-xs">
      {avatarUrl ? <img src={avatarUrl} alt={label} className="size-3.5 rounded-full" /> : null}
      {color ? (
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: `#${color}` }} />
      ) : null}
      {label}
      <button
        type="button"
        className="text-foreground-muted ml-0.5 rounded-sm hover:text-foreground"
        onClick={onRemove}
        aria-label={`Remove ${label} filter`}
      >
        <X className="size-2.5" />
      </button>
    </span>
  );
}
