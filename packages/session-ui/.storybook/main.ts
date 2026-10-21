import type { StorybookConfig } from '@storybook/react-vite';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import { mergeConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { emdashAliasEntries } from '../../../apps/desktop/electron/sessionpage/emdash-aliases.mjs';

// @@@task-fusion (#2802 遗留, 修于 #3067) — Solid 与 React 在同一次 rollup 里共存的分界线。
// 与 vite.config.mts 用的是同一个常量语义:全仓只有 session-chat-ui 这一个包是 Solid。
const SESSION_CHAT_UI_GLOB = '**/packages/session-chat-ui/**';

// @@@task-fusion (#2802 遗留, 修于 #3067) — 别名走全仓唯一那张表,storybook 不再自备一份。
//
// 这里原本手写了 `@` / `@react` / `@styles` / `@theme` 四条 —— 那是旧的包内别名。
// #2802 把它们统一成了 `@session-ui/*`,但只改了 vite.config.mts / vitest.config.ts / emdash-esbuild.mjs
// 三条构建路,漏了 storybook 这一条。结果是:源码里 207 处 `@session-ui/...` 在 storybook 里一个都解析不到,
// 而那四条手写别名的实际用量是 **0** —— 一张全是死条目的表,却是唯一被读到的那张。
//
// 症状是 `storybook build` 在干净 dev 上就红(Rollup 解析不到 `@session-ui/...`),而 `tsgo --noEmit` 全绿:
// 类型检查读 tsconfig.json 的 paths,构建读这张表,两个真相源分叉时只有构建那侧会炸。
// 所以修法不是在这里补一条 `@session-ui`(那会让真相源变成四个),而是**直接消费那张表**,
// 与另外三条构建路同源 —— 顺序有意义(@rollup/plugin-alias 语义:精确子路径必须排在基路径之前),
// 故与 vite.config.mts 一样用数组而非对象。
const sessionAliases = emdashAliasEntries.map(([find, replacement]) => ({ find, replacement }));

const config: StorybookConfig = {
  stories: ['../src/react/**/*.mdx', '../src/react/**/*.stories.tsx'],
  addons: ['@storybook/addon-docs'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  viteFinal: (config) =>
    mergeConfig(config, {
      // @@@task-fusion (#2802 遗留, 修于 #3067) — session-chat-ui 是 Solid 写的,其余全仓是 React。
      // 它的源码带 `/** @jsxImportSource solid-js */`,而 vite 默认用 esbuild 按 automatic runtime 转,
      // 会生成 `import { jsx } from 'solid-js'` —— solid-js 根本没导出 `jsx`,构建当场炸。
      // Solid 的 JSX 不是通用 runtime,是编译期展开成 DOM 操作,必须由 babel-preset-solid 转。
      // 只吃 session-chat-ui;storybook 的 react-vite 框架自己不注入 babel react 插件(viteFinal 时
      // 插件表里只有 storybook:react-docgen-plugin),React 那侧走 esbuild,两者按路径互不重叠。
      plugins: [
        vanillaExtractPlugin(),
        solid({ include: [SESSION_CHAT_UI_GLOB], extensions: ['.tsx', '.ts', '.jsx', '.js'] }),
      ],
      resolve: {
        alias: sessionAliases,
      },
      // Pre-bundle VE runtime modules so Vite doesn't re-optimize them mid-render
      // (which would duplicate React and cause a `useState` null crash in Storybook).
      optimizeDeps: {
        include: [
          '@vanilla-extract/sprinkles/createRuntimeSprinkles',
          '@vanilla-extract/recipes/createRuntimeFn',
        ],
      },
    }),
};

export default config;
