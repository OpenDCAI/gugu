import { X } from '@/lib/icons'
import { Button } from '@renderer/lib/ui/button';
import { MicroLabel } from '@renderer/lib/ui/label';
import { SHEET_SAFE_INSET_RIGHT } from '@renderer/lib/ui/sheet';

export function SheetHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div
      className="flex flex-row items-center justify-between gap-1.5 p-4"
      // 自动化的抽屉也是 `side=right` 的 SheetContent ⇒ 它这颗 ✕ 与窗口的 ✕ 落在同一个角。
      // 车道宽度由 SheetContent 按 side 声明,这里只读同一个表达式(见 @@@sheet-window-controls-lane)。
      style={{ paddingRight: SHEET_SAFE_INSET_RIGHT }}
    >
      <MicroLabel>{title}</MicroLabel>
      <Button variant="ghost" size="sm" onClick={onClose} className="p-0">
        <X className="size-4" />
      </Button>
    </div>
  );
}
