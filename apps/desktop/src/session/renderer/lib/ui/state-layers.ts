/**
 * 选中行在悬浮/按下时的正确写法。
 *
 * 坑在特异性上,不在颜色上:Tailwind 的 `hover:bg-row-hover` 编译成
 * `.hover\:bg-row-hover:hover`,是「一个类 + 一个伪类」= (0,2,0);
 * 而选中色 `bg-background-2` 只是「一个类」= (0,1,0)。所以只要基串里带了
 * `hover:bg-*`,**鼠标一碰选中行,选中底色就被悬浮色整个换掉** —— 行看上去不再是选中的。
 * 无报错、无警告,只有在「选中 + 悬浮」这一个组合下才显形。
 *
 * 所以选中分支要做两件事:
 * 1. 自己再写一遍 `hover:bg-<选中色> active:bg-<选中色>`,把 background-color 钉死在选中色上
 *    (`cn` 是 clsx + tailwind-merge,同组同修饰符后写的会把基串里那条摘掉,不留下平局);
 * 2. 用这里的两个类,把悬浮/按下档以 **background-image 渐变层**叠在选中底色**之上** ——
 *    层叠而不是替换,阶梯才还是 hover < press < selected 的方向。
 *
 * ❌ 别只写 `hover:bg-row-hover` 就完事(那是替换),
 * ❌ 也别只加层不钉 background-color(基串的 hover 仍然会把底色换掉)。
 */
export const STATE_LAYERS = 'hover:state-hover-layer active:state-press-layer';
