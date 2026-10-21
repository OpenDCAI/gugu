// 视图表的**运行时**持有处。
//
// 为什么不直接 `import { views } from '@renderer/app/view-registry'`:视图表要 import 每一个视图,而视图里的
// 组件又要用导航(useNavigate / useParams / 命令注册)。导航那一侧若再在运行时 import 视图表,就成了一个
// 覆盖整个会话页的循环 import —— 开发版里改任何一个处在环上的文件,Vite 都判「循环 import、无法热更新」,
// 按错误的执行顺序重载模块(「Cannot access 'NewSessionPage' before initialization」),会话页半挂,
// 整页落到「useTheme must be used within a ThemeProvider」(#6264 实测复现:改 use-create-session-callback.ts 必现)。
//
// 所以依赖方向只留一条:入口(embedded.tsx → setupNavigationGuards)把视图表登记到这里,导航侧只读这里。
// 这个文件对视图表只有类型依赖。
import type { ViewId, ViewDefinition } from '@renderer/app/view-registry';

type ViewTable = Record<ViewId, ViewDefinition<Record<string, unknown>>>;

let registered: ViewTable | null = null;

export function registerViews(table: ViewTable): void {
  registered = table;
}

/** 入口还没登记就被读 = 装配顺序错了,当场报出来,❌ 返回空表让页面静默变白。 */
export function registeredViews(): ViewTable {
  if (!registered) throw new Error('views are read before setupNavigationGuards() registered them');
  return registered;
}
