import type { StorybookConfig } from 'storybook-solidjs-vite';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import { mergeConfig } from 'vite';
import { emdashAliasEntries } from '../../../apps/desktop/electron/sessionpage/emdash-aliases.mjs';

// @@@task-fusion (#2804 遗留, 修于 #3526) — 别名走全仓唯一那张表,storybook 不再自备一份。
//
// 这里原本手写了 `@components` / `@core` / `@lib` / `@state` / `@styles` / `@` 六条 —— 那是并入本体
// **之前**的包内别名。#2802 把它们统一成了 `@session-chat/*`,而这六条在源码里的实际用量是 **0**
// (唯一的 `@core/` 字样在一句注释里),却是唯一被读到的那张表 —— 于是源码里 663 处 `@session-chat/...`
// 在 storybook 里一个都解析不到,`storybook build` 在干净 dev 上直接红在
// `@session-chat/stories/_harness/chat-host`。类型检查读 tsconfig.json 的 paths,构建读这张表,
// 两个真相源分叉时只有构建那侧会炸,所以四门全绿照不出它。
// 修法与 session-ui 的 `.storybook/main.ts` 同源(#3067/#3075):直接消费那张表,顺序有意义
// (@rollup/plugin-alias 语义:精确子路径必须排在基路径之前),故与 vite.config.mts 一样用数组。
const sessionAliases = emdashAliasEntries.map(([find, replacement]) => ({ find, replacement }));

const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs'],
  framework: 'storybook-solidjs-vite',
  viteFinal: (config) =>
    mergeConfig(config, {
      // @@@task-fusion (#2804 遗留, 修于 #3526) — VE 编译器必须由这里注册。
      //
      // 这里原本写着「不要注册 vanillaExtractPlugin(),storybook 的 vite builder 会自动加载
      // 包级 vite.config.ts,那份已经提供了它」。那份 `packages/chat-ui/vite.config.ts` 随 #2804
      // 删 vendor/ 一起消失了,它带走的正是 VE plugin + 下面那份 optimizeDeps + 六条包内别名;
      // 而 storybook 并不会去加载根 vite.config.mts。一条描述已消失文件的注释比没有注释更坏:
      // 它让读它的人以为配置在别处,于是没人去补。
      //
      // 缺它的症状与缺别名**不同形**,这是两条独立缺陷:别名缺失时 rollup 当场炸,而 VE 缺失时
      // 构建照样 exit=0、`index.json` 照样登记全部 story,只有预览 iframe 是空的 ——
      // `.css.ts` 被当普通 TS 编译,`style()` 在浏览器里抛
      // 「Styles were unable to be assigned to a file」,整个 story 一个节点都挂不上。
      // Solid 的 JSX 转换不在这里注册:framework `storybook-solidjs-vite` 自带,
      // 与 session-ui 那侧(React 框架里手动 include 本包)方向相反。
      plugins: [vanillaExtractPlugin()],
      // Warm up the global stylesheet chain at server start. The VE plugin's
      // resolveId for a virtual `*.vanilla.css` throws ("No CSS for file") when
      // the parent .css.ts has not been transformed yet, which the preview's
      // bootstrap imports hit on a cold start. Pre-transforming them populates
      // the VE CSS map before the browser requests the virtual CSS. (Safe only
      // because optimizeDeps below pre-bundles the VE runtimes, so warmup no
      // longer triggers a dep re-optimization that would reset the compiler.)
      // Listed explicitly rather than globbed so warmup never pre-transforms
      // variable-theme-contract.css.ts, whose function export trips Vite's SSR
      // "Invalid exports" check.
      server: {
        warmup: {
          clientFiles: [
            './src/styles/reset.css.ts',
            './src/styles/theme.css.ts',
            './src/styles/effects.css.ts',
            './src/styles/global.css.ts',
            './src/styles/storybook.css.ts',
          ],
        },
      },
      resolve: {
        alias: sessionAliases,
      },
      // Pre-bundle the vanilla-extract runtime helpers. They are injected into
      // compiled .css.ts output, so Vite's initial dep scan never sees them; left
      // out, they are discovered lazily and trigger a mid-session re-optimization
      // + reload that resets the VE compiler and causes "No CSS for file" throws.
      optimizeDeps: {
        include: [
          '@vanilla-extract/sprinkles/createRuntimeSprinkles',
          '@vanilla-extract/recipes/createRuntimeFn',
        ],
      },
    }),
};

export default config;
