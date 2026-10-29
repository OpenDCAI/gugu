import { cn } from '@/lib/cn'

// @@@sheet-motion (#4323) - 从 Sheet.tsx 挪出来的:变体串要能被判据消费
// (tests/unit/desktop/styles/motionTransitionCoverage.test.ts 真编译它们),
// 而从组件文件导出常量会触发 react-refresh/only-export-components,
// 那条规则的建议本身就是「单开一个文件放共享常量」。顺带把判据从 jsdom 里解放出来:
// Sheet.tsx 经 useMobileShell 拉到 platform/index.ts,那里模块顶层就读 window。
//
// @@@sheet-variants - Sheet 样式的唯一真相。进场沿用 tokens.css 里那三条已调好的 keyframe,
// 退场是新增的:原来关闭是"直接消失",移动端底部抽屉尤其突兀 —— 现在滑回去/缩回去。
// `gg-sheet-viewport` 类名保留:devicesSectionInteraction.test.ts 按它定位。
//
// @@@4323 时长与曲线从 `animate-[...]` 里的字面量换成 token:原来进场写死 180/200/300ms +
// cubic-bezier(0.22,1,0.36,1),退场却已经用 `var(--dur-med)` —— 同一个抽屉一进一出两个来源。
// 现在进退都读 token:backdrop 与桌面卡片走 `--dur-med`,移动底部抽屉走 `--dur-slow`
// (它要走完整屏宽的位移,快了会像被弹出来),曲线统一 `--ease-spring`(tokens.css 里就是标给抽屉的那条)。
export const sheetBackdropMotion = cn(
  // 几何归 `.gg-window-layer`(tokens.css @@@window-layer):铺在 Windows 标题栏行下面。
  'gg-window-layer bg-[var(--bg-overlay-modal)]',
  'animate-[gg-sheet-overlay-in_var(--dur-med)_var(--ease-spring)]',
  'transition-opacity duration-[var(--dur-med)] [transition-timing-function:var(--ease-spring)] data-[ending-style]:opacity-0',
  'data-[ending-style]:animate-none motion-reduce:animate-none motion-reduce:transition-none',
)

export const sheetContentMotion = cn(
  'flex flex-col overflow-hidden outline-none pointer-events-auto',
  'data-[sheet-mobile=false]:bg-[var(--modal-bg)] data-[sheet-mobile=false]:shadow-[var(--modal-shadow)]',
  // 桌面:居中卡片,弹入。#7333 半像素轮廓画在 --shadow-dialog 里,❌ 再叠一条 border(边 + 环 + 影三层同一条边)。
  'data-[sheet-mobile=false]:animate-[gg-sheet-pop-in_var(--dur-med)_var(--ease-spring)]',
  'data-[sheet-mobile=false]:data-[ending-style]:scale-[0.98]',
  // 移动:贴底抽屉,上滑进场、下滑退场(底部安全区的 padding 见 mobileStyle)。
  'data-[sheet-mobile=true]:animate-[gg-sheet-slide-up_var(--dur-slow)_var(--ease-spring)]',
  'data-[sheet-mobile=true]:data-[ending-style]:translate-y-6',
  // @@@sheet-scroll 移动抽屉放不下的部分由抽屉自己滚,手指在抽屉里哪儿都划得动。
  // 原来整张 overflow:hidden,哪块该滚由调用方各自指定(#6908 一个个补):指定成组内滚的,
  // 那一组被压成两行半的小窗、在半截处切开,其余部分划不动;没指定的,多出的直接裁掉、够不着(owner 10-07)。
  // 调用方要钉住页脚之类的,照旧自己留一块 min-h-0 的滚动区 —— 放得下时这一层不滚。
  'data-[sheet-mobile=true]:overflow-y-auto data-[sheet-mobile=true]:overscroll-contain',
  // @@@tw4-transform-split - 退场那两条(移动 translate-y-6 / 桌面 scale-[0.98])在 v4 里落到
  // translate 与 scale 两个独立属性上;只列 transform 的话本文件开头写的「滑回去/缩回去」不成立,
  // 退场会退化成纯淡出。
  'transition-[opacity,transform,translate,scale,rotate] duration-[var(--dur-med)] [transition-timing-function:var(--ease-spring)] data-[ending-style]:opacity-0',
  'data-[ending-style]:animate-none motion-reduce:animate-none motion-reduce:transition-none',
)
