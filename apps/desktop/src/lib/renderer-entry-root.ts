import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'

/**
 * 渲染入口**唯一**的挂载口。两个入口(`main.tsx` 的 `#root`、会话页 `embedded.tsx` 的
 * `__EMDASH_MOUNT__`)都必须走这里 —— ❌ 别在任何入口里直接 `createRoot`。
 *
 * ## 为什么必须有这一层
 *
 * vite 热更新**会重新执行整个入口模块**,而且是**先执行新模块、再**决定要不要整页重载。
 * 所以「让入口声明自己不可热替换」堵不住这件事:第二个 root 在那个决定之前就已经建出来了。
 * 于是模块顶层那句 `createRoot(container)` 在**同一个容器**上跑了第二遍。React 对此只
 * `console.error` 一句「已经 createRoot 过」,然后**照样把第二棵树建出来** ——
 * 两棵互不知情的 React 树争同一片 DOM。它不是警告,是既成事实。
 *
 * ## 后果是实测的,不是推演(2026-09-01)
 *
 * 只改一次 `embedded.tsx`(动了一行注释):
 *   1. 第二棵树的终端面板去给同一个 `FrontendPty` 挂输入处理器
 *      → `FrontendPty … already has an attached input handler` 抛错;
 *   2. ErrorBoundary 拆子树,拆的过程甩出一串
 *      `removeChild: The node to be removed is not a child of this node`(**这是余波,不是病根**);
 *   3. 拆的过程把那个会话对象 dispose 掉。它活在 `FrontendPty.bySession` 这张**React 之外**的
 *      静态表里 ⇒ 再打开那个任务就是 `is disposed; mount() cannot revive it`,
 *      **刷新无用,只能重启整个 app**。
 *
 * 生产包没有 HMR,所以这条只咬开发与验收 —— 但它咬得很深:开发者改一次入口文件,手上的任务
 * 就永久打不开了,且报错指向终端,没人会怀疑到「我刚才存了个文件」。
 *
 * ## 为什么是「复用 root」而不是「发现建过就跳过」
 *
 * 跳过 = 热更新静默失效(改了码界面不动),等于把一个响亮的错换成一个沉默的错。
 * 复用已有 root 再 `render()` 才是热更新本来就该有的语义。
 */
type EntryRoot = { owner: string; root: Root }

/**
 * 容器 → 已建 root。
 *
 * 存活机制有两层,缺一不可:
 *  · **模块作用域**:热更新只重执行被改的模块,不重执行它的依赖 ⇒ 入口被重执行时本模块还是原来那份;
 *  · **`import.meta.hot.data`**:万一被改的是**本模块自己**,模块作用域会丢,靠它接住。
 *
 * 生产构建里 `import.meta.hot` 恒为 undefined、整段被摇掉,只剩一个最多一条记录的 Map。
 */
// ⚠️ `import.meta.hot` 存在**不代表** `.data` 存在:vitest(vite-node)下 hot 对象在、data 是
//    undefined。写成 `import.meta.hot?.data.entryRoots` 会在测试里当场抛 —— 这是单测逮到的,
//    不是推演出来的。两层可选链缺一不可。
const hotData = import.meta.hot?.data as { entryRoots?: Map<Element, EntryRoot> } | undefined
const ENTRY_ROOTS: Map<Element, EntryRoot> = hotData?.entryRoots ?? new Map()
if (hotData) hotData.entryRoots = ENTRY_ROOTS

/**
 * 这个容器上是否已经有本进程建好的 root。
 *
 * 入口拿它判断「一次性 bootstrap 该不该再跑一遍」—— 重跑一次性接线(可见性桥、命令提供者、
 * 缓存失效桥、扩展注册、导航/侧栏快照恢复)会挂重复监听,并把开发者手上的位置拽回快照。
 */
export function hasEntryRoot(container: Element): boolean {
  return ENTRY_ROOTS.has(container)
}

/**
 * 把 `tree` 渲染进 `container`:首次建 root,之后复用同一个 root 重渲染。
 *
 * `owner` 是入口的身份(如 `'desktop'` / `'session-embedded'`)。两个不同入口指向同一个容器
 * 是配置错误 —— 此处**响亮地失败**,而不是让后来者悄悄顶掉前一棵树:那种"成功"会表现为
 * 整个桌面端界面被会话页替换,而日志里一个字都没有。
 */
export function renderEntryRoot(owner: string, container: Element, tree: ReactNode): Root {
  const existing = ENTRY_ROOTS.get(container)
  if (existing) {
    if (existing.owner !== owner) {
      // 英文不是随口挑的:这是**开发者面**的不变量报错,与 `FrontendPty … already has an
      // attached input handler` 同族;中文会被 `hardcoded-cjk-audit` 判成用户可见文案而拦下。
      throw new Error(
        `Renderer entry '${owner}' targets a container already owned by entry `
          + `'${existing.owner}'; one container can host only one React tree.`
      )
    }
    existing.root.render(tree)
    return existing.root
  }
  const root = createRoot(container)
  ENTRY_ROOTS.set(container, { owner, root })
  root.render(tree)
  return root
}
