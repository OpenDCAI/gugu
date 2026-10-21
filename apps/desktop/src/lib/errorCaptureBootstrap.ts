// @@@logging (#2382) - 渲染层错误捕获的**最早**挂钩点。只做一件事:import 即装钩。
//
// 为什么要单独一个模块:ES 模块会把整张导入图**先求值完**,才执行导入方的函数体 —— 所以写在 main.tsx 里的
// `installErrorRingBuffer()` 再往上挪也没用,它永远晚于 `import App` 那条链。而渲染层最要命的失败恰恰就是
// 「启动期模块求值就抛」(实测:缺 VITE_SUPABASE_* → App 的导入链在 module-eval 期 throw,白屏,钩子根本
// 没机会装,报错既不进内存快照也不回传 —— 一点证据都没有)。
//
// 所以:让挂钩本身发生在 import 期,并在 main.tsx 里作为**第一个** import 出现。
// 与主进程那边同一个教训 —— 启动早期才是最需要日志的一段(见 logger.ts 的 LateFileSink)。
import { installErrorRingBuffer } from './errorRingBuffer'

installErrorRingBuffer()
