/**
 * Solar 图标的转发出口 —— 真身在 `packages/session-ui/src/icons.tsx`(生成物)。
 *
 * 为什么真身要放进 session-ui 而不是留在这里:`packages/session-ui` 是被 app 消费的包,
 * 够不到 `apps/desktop/src`,`@/lib/icons` 在它内部解析不了。图标留在 app 侧,
 * session-ui 那 20 个文件就只能继续用 lucide —— 于是同一屏上会出现「下拉的勾是 lucide、
 * 旁边菜单项的图标是 Solar」。依赖方向是 desktop → session-ui,所以真身下沉到 session-ui,
 * 两边都够得到。
 *
 * 这个转发文件保留是刻意的:235 个文件写的是 `@/lib/icons`,不必为了搬家全改一遍。
 * app 侧继续用 `@/lib/icons`,session-ui 内部用相对路径。
 *
 * ❌ 别在这里加图标 —— 改 `scripts/icons/solar-icons.json` 再跑 `node scripts/gen-icons.mjs`。
 */
// react-refresh 那条规则没法看穿 `export *`,所以只能定向豁免。
// 这里转发的确实只有组件:173 个图标组件 + `IconProps` / `IconComponent` 两个类型
// (类型编译期就擦掉了,不进运行时导出),不存在「组件与非组件混在一个模块」的 HMR 问题。
// eslint-disable-next-line react-refresh/only-export-components
export * from '@gugu/session-ui/icons'
