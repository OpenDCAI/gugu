import type { ComponentType } from 'react';
import type { TabContentProps } from './tab-provider';

/**
 * @@@tab-views — 页签的「界面那半」(pane 里画的内容)不随 provider 走,由任务页入口在启动时登记进来。
 *
 * provider(数据那半:initialize / dispose / commands / 页签条上那一枚)要同步可用:它沿着
 * app-state → session-store → WorkspaceViewModel → 页签注册表一路被同步构造,咕咕主界面(手机也是)启动时
 * 就够得着它。内容组件连着编辑器(Monaco)、对话面板(shiki)、diff 这些大依赖 —— 写在 provider 里,
 * 它们就跟着进了手机的启动包,而手机从来不挂任务页。
 * ⇒ 内容组件放进只有任务页入口(embedded.tsx)import 的 session-tab-views,在那里 React.lazy 后登记到这里;
 *   provider 只留一个按 kind 取登记内容的薄壳。手机不加载任务页入口 ⇒ 那些 import() 手机够不着,不进手机包。
 */
const views = new Map<string, ComponentType<TabContentProps>>();

export function registerTabViews(entries: Record<string, ComponentType<TabContentProps>>): void {
  for (const [kind, view] of Object.entries(entries)) views.set(kind, view);
}

/** provider 的 TabContent:渲染时取这种页签登记的内容组件。没登记 = 任务页入口没装上它,当场抛。 */
export function registeredTabView(kind: string): ComponentType<TabContentProps> {
  function RegisteredTabView(props: TabContentProps) {
    const View = views.get(kind);
    if (!View) throw new Error(`tab view for kind "${kind}" is not registered (session-tab-views installs it at task-page boot)`);
    return <View {...props} />;
  }
  RegisteredTabView.displayName = `RegisteredTabView(${kind})`;
  return RegisteredTabView;
}
