// @@@gugu-vendor — 打开 Immer 的 patches 插件。
//
// 生产路径上这件事由 @gugu/session-wire 的 src/live/state/immer-setup.ts 在 import 时完成
// (LiveState.produce 用的 produceWithPatches 就是从那儿导出的)。但在 core 的单测里,
// 被测模块常常先于那条链路加载,于是 produceWithPatches 撞上
// "[Immer] The plugin for 'Patches' has not been loaded"。
// immer 的插件注册是模块级单例,这里在测试启动时先注册一次即可,与生产行为一致。
import { enablePatches } from 'immer';

enablePatches();
