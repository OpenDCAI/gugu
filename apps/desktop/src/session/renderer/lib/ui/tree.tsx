// 树形列表原语:headless-tree 管状态(展开/焦点/选中/键盘),这里只管长相。
// 参照 ReUI Tree 的分工(Tree / TreeItem / TreeItemLabel),样式换成咕咕 token;
// 行是 role=treeitem 的 div 而不是 <button>(headless-tree 自己给 tabIndex/键盘,套 button 是双重可交互)。
import type { ItemInstance, TreeInstance } from '@headless-tree/core';
import { createContext, useContext, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { ChevronRight } from '@/lib/icons';
import { cn } from '@renderer/utils/utils';

const DEFAULT_INDENT = 16;

// 上下文只放长相需要的事实,不放 ItemInstance:它对 T 是不变型的,放进去会逼着所有调用方擦成 any。
type TreeContextValue = { indent: number; folder?: boolean; expanded?: boolean };

const TreeContext = createContext<TreeContextValue>({ indent: DEFAULT_INDENT });

type TreeProps<T> = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  tree: TreeInstance<T>;
  /** 每层缩进的像素数。 */
  indent?: number;
  /** aria-label:一棵树对读屏器叫什么。 */
  label: string;
  children: ReactNode;
};

export function Tree<T>({ tree, indent = DEFAULT_INDENT, label, className, children, ...props }: TreeProps<T>) {
  const { style, ...container } = tree.getContainerProps(label) as HTMLAttributes<HTMLDivElement> & {
    style?: CSSProperties;
  };
  return (
    <TreeContext.Provider value={{ indent }}>
      <div
        data-slot="tree"
        {...props}
        {...container}
        style={{ ...style, ...props.style }}
        className={cn('flex flex-col gap-px outline-none', className)}
      >
        {children}
      </div>
    </TreeContext.Provider>
  );
}

type TreeItemProps<T> = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  item: ItemInstance<T>;
  children: ReactNode;
};

export function TreeItem<T>({ item, className, children, ...props }: TreeItemProps<T>) {
  const parent = useContext(TreeContext);
  const itemProps = item.getProps() as HTMLAttributes<HTMLDivElement>;
  const padding = item.getItemMeta().level * parent.indent;
  return (
    <TreeContext.Provider value={{ ...parent, folder: item.isFolder(), expanded: item.isExpanded() }}>
      <div
        data-slot="tree-item"
        data-folder={item.isFolder() || undefined}
        data-selected={item.isSelected() || undefined}
        data-focus={item.isFocused() || undefined}
        {...props}
        {...itemProps}
        style={{ paddingInlineStart: padding }}
        className={cn('outline-none select-none', className)}
      >
        {children}
      </div>
    </TreeContext.Provider>
  );
}

type TreeItemLabelProps = HTMLAttributes<HTMLSpanElement> & {
  /** 折叠箭头右边、名字左边的那一格(通常是图标)。 */
  icon?: ReactNode;
  /** 名字右边靠右的那一格(状态/计数)。 */
  trailing?: ReactNode;
};

export function TreeItemLabel({ icon, trailing, className, children, ...props }: TreeItemLabelProps) {
  const { folder, expanded } = useContext(TreeContext);
  if (folder === undefined) throw new Error('TreeItemLabel 必须放在 TreeItem 里');
  return (
    <span
      data-slot="tree-item-label"
      className={cn(
        'flex h-8 items-center gap-2 rounded-md px-2 text-sm text-foreground transition-colors',
        'hover:bg-row-hover',
        'in-data-[selected]:bg-row-selected in-data-[selected]:font-medium',
        // 键盘巡航要看得见落点,但 spec 不许画环 —— 焦点借悬浮那一档表达。
        // 焦点落在祖先 TreeItem 上(Base UI 的 roving tabindex),所以用 in-* 变体;
        // 用层不用底色,是因为这一行可能同时是选中的,底色得留给选中。
        'in-focus-visible:state-hover-layer',
        'active:bg-row-press',
        '[&_svg]:pointer-events-none [&_svg]:shrink-0',
        className
      )}
      {...props}
    >
      <ChevronRight
        aria-hidden
        className={cn(
          'size-4 text-foreground-muted transition-transform',
          !folder && 'invisible',
          expanded && 'rotate-90'
        )}
      />
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </span>
  );
}
