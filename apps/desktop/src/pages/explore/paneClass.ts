/**
 * 发现页各 pane 的显隐类名。
 *
 * 抽出来不是为了少打几个字：`gg-dpane` / `gg-on` 是 ExplorePage.css 与各 pane 组件之间的
 * 契约，写在两个文件里意味着改名时不会报错、只会静默失效 —— 面板还在 DOM 里，
 * 只是永远不显示。放一处，改名时 TypeScript 至少能把调用点全指出来。
 *
 * 为什么是 class 而不是条件渲染：两个 pane 都常驻 DOM（切回来不重拉数据、
 * 测试也能在隐藏 pane 里找到按钮），显隐交给 CSS。
 */
export function discoverPaneClass(active: boolean): string {
  return active ? 'gg-dpane gg-on' : 'gg-dpane'
}
