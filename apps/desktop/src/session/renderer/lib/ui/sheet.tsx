import { Dialog as SheetPrimitive } from '@base-ui/react/dialog';
import { XIcon } from '@/lib/icons'
import * as React from 'react';
import { useUiPortalContainer } from '@gugu/session-ui/react/primitives';
import { cn } from '@renderer/utils/utils';
import { MicroLabel } from './label';

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return (
    <SheetPrimitive.Portal data-slot="sheet-portal" container={useUiPortalContainer()} {...props} />
  );
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-[var(--bg-overlay-soft)] transition-opacity duration-[var(--dur-med)] data-ending-style:opacity-0 data-starting-style:opacity-0',
        className
      )}
      {...props}
    />
  );
}

/**
 * @@@sheet-window-controls-lane (#6034) - 贴着窗口上沿右段的 Sheet 必须让开自绘窗口按钮那条车道。
 *
 * `side=right`(默认)的 Sheet 是 `inset-y-0 right-0`:它的右上角**就是窗口的右上角**。
 * Windows/Linux 是无边框窗口、min/max/close 由咕咕壳自绘在那里(`--titlebar-controls-width`,
 * 见 tokens.css 的 `@@@822-titlebar-controls`),于是 Sheet 头部那颗右对齐的关闭 ✕ 与窗口的 ✕
 * 落在同一片像素上:屏幕上两个 ✕ 叠着,点下去谁接到由层叠顺序决定。mac 的交通灯在左上,
 * 同一份代码在那里看不出问题 —— 这是 #3191(✕ 落进窗口拖拽矩形)之后同一族的第二个面孔。
 * 实测(Windows,1024 宽):抽屉 ✕ 992–1008×16–37 整个落在控制条 886–1024×0–40 里,交集 336px²,
 * 而 `elementFromPoint` 在 ✕ 正中心取到的是 `button.gg-winctl--close` —— 点它关的是**窗口**。
 *
 * 让开多少**只认 `--titlebar-controls-width` 这一个数**(❌ 别在消费者里拍 138/154 这类坐标);
 * 车道宽度由 Sheet 自己按 `side` 声明,贴在那个角上的东西只管把它读出来 —— 左/下侧的 Sheet
 * 压根不碰那个角,让它们也缩进去就是凭空的空洞。
 *
 * 三个消费者用法不同、读的是同一个数:两份 header 行当 `padding-right`(把右对齐的 ✕ 顶开),
 * 集成那份是 `absolute` 的 ✕ 当 `right`(它不在 header 行里)。❌ 别再各自拍一个值。
 */
export const SHEET_SAFE_INSET_RIGHT = 'calc(1rem + var(--sheet-window-controls-inset, 0px))';

function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton: _showCloseButton = true,
  style,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: 'top' | 'right' | 'bottom' | 'left';
  showCloseButton?: boolean;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        style={
          {
            '--sheet-window-controls-inset':
              side === 'right' || side === 'top' ? 'var(--titlebar-controls-width, 0px)' : '0px',
            // #6597 Windows 的窗口按钮住在自己那一行标题栏里(z 高于本层):贴上沿的抽屉从那一行下沿起,
            // 否则顶上一截(连同 ✕)钻到标题栏底下,点下去落在拖拽区或窗口按钮上。没有这一行的平台是 0。
            ...(side === 'bottom' ? {} : { top: 'var(--window-titlebar-height, 0px)' }),
            // 左右抽屉原是 inset-y-0 + h-full;上沿下移后改由上下两沿定高,❌ 让 100% 顶出窗口底。
            ...(side === 'right' || side === 'left' ? { height: 'auto' } : {}),
            ...(style as React.CSSProperties | undefined),
          } as React.CSSProperties
        }
        className={cn(
          // @@@sheet-not-floating (Refs #6106) — Sheet 是**贴边的全出血面板**,不是浮层。
          // design.md:「Never square a floating surface … A square surface with a shadow reads as
          // a crescent of light at each corner, and it is wrong every time.」方角 + lift 影是它
          // 逐字点名的失败模式,而这里四条边里有三条贴死窗口边缘 ⇒ 二选一取「不是浮层」那一边:
          // 删掉 shadow-sm,层级只由贴合边那一条 border-l/r/t/b 表达(下面 data-[side=*]:border-* 已有)。
          // ❌ 别改成「加圆角保阴影」:那会让贴死的三条边出现离缝。
          'fixed z-50 flex flex-col gap-4 bg-background-quaternary bg-clip-padding text-sm transition duration-[var(--dur-slow)] ease-in-out [-webkit-app-region:no-drag] data-ending-style:opacity-0 data-starting-style:opacity-0 data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=bottom]:data-ending-style:translate-y-[2.5rem] data-[side=bottom]:data-starting-style:translate-y-[2.5rem] data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=left]:data-ending-style:translate-x-[-2.5rem] data-[side=left]:data-starting-style:translate-x-[-2.5rem] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=right]:data-ending-style:translate-x-[2.5rem] data-[side=right]:data-starting-style:translate-x-[2.5rem] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=top]:data-ending-style:translate-y-[-2.5rem] data-[side=top]:data-starting-style:translate-y-[-2.5rem] data-[side=left]:sm:max-w-md data-[side=right]:sm:max-w-xl',
          className
        )}
        {...props}
      >
        {children}
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
}

function SheetHeader({
  className,
  label,
  children,
  style,
  ...props
}: React.ComponentProps<'div'> & { label?: string }) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex gap-1.5 p-4 justify-between', className)}
      {...props}
      // 行内写而不是再叠一条 `pr-[…]` 工具类:与 `p-4` 的胜负会随编译源序漂,而这一格的正确与否
      // 是几何(两个 ✕ 重不重叠),不该交给类名顺序去赌。调用点给的 style 仍然压得过它。
      style={{ paddingRight: SHEET_SAFE_INSET_RIGHT, ...style }}
    >
      {label && <MicroLabel>{label}</MicroLabel>}
      {children}
      <SheetClose>
        <button className="mr-0 ml-auto text-foreground-muted hover:text-foreground">
          <XIcon className="size-4" />
        </button>
      </SheetClose>
    </div>
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        'mt-auto flex flex-col gap-2 p-3 bg-background-quaternary-1 border-t',
        className
      )}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('font-medium text-foreground', className)}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm text-foreground-muted', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
