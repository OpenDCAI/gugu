// @@@gugu-vendor(#2633) — vite-plugin-solid 检测到 vitest 就**无条件**往 setupFiles 里注入
// '@testing-library/jest-dom/vitest'(它把该包列为**可选** peer,所以 pnpm 不装也不报错)。
// 在咕咕的 isolated 布局下这有两个后果:
//   1. 包不在 chat-ui 自己的 node_modules 里 → 裸标识符解析失败(已在 package.json 补上声明);
//   2. 即使装上,它位于 workspace 根的 store、在 Vite 的 root 之外 → 被注入成 `/@fs/...` 绝对路径,
//      而 `caches.test.ts` / `parse.test.ts` 这两个用 jsdom 环境的文件加载不了它。
// 插件的注入条件是「现有 setupFiles 里没有任何一项路径匹配 /jest-dom/」,所以这个文件既让它
// 别再注入,又把 import 交回 Vite 走正常解析。
// ❌ 别把这里改成空文件来"绕过"——那样 jest-dom 的匹配器就真没装上,是骗自己。
import '@testing-library/jest-dom/vitest';
