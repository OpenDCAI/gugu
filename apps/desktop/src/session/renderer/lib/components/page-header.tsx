import { createContext, useContext, type ReactNode } from 'react';
import { SettingsNote } from '@/components/settings/SettingsPrimitives';

/**
 * #6264 这一页看的是哪台机器。按机器的模块(资源库、已安排、设置里的通用 / 仓库 / 存储)在模块层
 * 挂一份,模块里**每一页**的标题右边都画同一个机器选择器,标题下那句说明写出那台机器的名字。
 * 一个位置、一个组件:❌ 挂在左栏列头下、搜索框旁、设置行里(owner:「如果设备是关键,
 * 你是否应该放到更显眼的位置,并且那个组件统一且好看」)。
 */
export type PageScope = {
  /** 标题右边那一格(机器选择器)。 */
  control: ReactNode;
  /** 看的是别的机器时它的名字;本机 = null(说明照旧)。 */
  deviceLabel: string | null;
};

const PageScopeContext = createContext<PageScope | null>(null);

export function PageScopeProvider({ value, children }: { value: PageScope; children: ReactNode }) {
  return <PageScopeContext.Provider value={value}>{children}</PageScopeContext.Provider>;
}

/**
 * 这一页画在壳的设置弹窗里(product spec):页名与 ✕ 在弹窗自己的标题栏上,这里 ❌ 再画一遍名字、
 * ❌ 吸顶。机器选择器与说明照旧留在内容最上面,说明用设置弹窗那一种(SettingsNote)。
 */
const InSettingsPanelContext = createContext(false);

export function InSettingsPanelProvider({ children }: { children: ReactNode }) {
  return <InSettingsPanelContext.Provider value={true}>{children}</InSettingsPanelContext.Provider>;
}

export function PageHeader({
  title,
  description,
  remoteDescription,
  scope: scopeProp,
  children,
  sticky = false,
  aside,
  showTitleInSettings = false,
}: {
  title: string;
  description?: string;
  /**
   * 看别的机器时的说明,把机器名自然地写进句子(「管理 d22 上的智能体和模型配置。」)。
   * 缺省 = 照旧用 description;按机器的页都该给这一句。
   */
  remoteDescription?: (device: string) => string;
  /** 直接给这一页一个范围;缺省读模块层挂的那一份。 */
  scope?: PageScope | null;
  children?: ReactNode;
  sticky?: boolean;
  /** 标题与说明右边那一格(App 页的搜索框,#7059 原型「顶上『App』+ 一句话,右边搜索」)。 */
  aside?: ReactNode;
  /** A distinct section heading inside the settings panel, e.g. “My subscriptions”. */
  showTitleInSettings?: boolean;
}) {
  const inherited = useContext(PageScopeContext);
  const scope = scopeProp === undefined ? inherited : scopeProp;
  const device = scope?.deviceLabel ?? null;
  const shownDescription = device && remoteDescription ? remoteDescription(device) : description;
  if (useContext(InSettingsPanelContext) && !showTitleInSettings) {
    return (
      <div className="flex flex-col gap-4">
        {scope?.control ? <div className="flex min-w-0" data-slot="page-scope">{scope.control}</div> : null}
        {shownDescription ? <SettingsNote>{shownDescription}</SettingsNote> : null}
        {children}
      </div>
    );
  }
  const heading = (
      <div className="flex min-w-0 flex-col gap-1 [-webkit-app-region:drag]">
        {/* 标题与机器选择器同一行、居中对齐(标题 28px 行高、ghost 触发器 28px 高,中线重合)。
            ghost 自带 8px 内边距,gap-1 让名字离标题 12px。选择器可点 ⇒ 这一格退出窗口拖拽区。 */}
        <div className="flex min-w-0 items-center gap-1" data-slot="page-title-row">
          <h2 className="gg-type-page-title shrink-0">{title}</h2>
          {scope?.control ? (
            <div className="flex min-w-0 [-webkit-app-region:no-drag]" data-slot="page-scope">
              {scope.control}
            </div>
          ) : null}
        </div>
        {shownDescription ? <p className="text-sm text-foreground-muted">{shownDescription}</p> : null}
      </div>
  );
  const body = (
    <div className="flex flex-col gap-6">
      {aside ? (
        <div className="flex items-start justify-between gap-4">
          {heading}
          <div className="flex shrink-0 [-webkit-app-region:no-drag]">{aside}</div>
        </div>
      ) : (
        heading
      )}
      {children ? <div className="flex flex-col gap-4 [-webkit-app-region:no-drag]">{children}</div> : null}
    </div>
  );

  if (!sticky) return body;

  return (
    <div className="sticky top-0 z-10 bg-background pt-10 pb-4 [-webkit-app-region:drag]">{body}</div>
  );
}
