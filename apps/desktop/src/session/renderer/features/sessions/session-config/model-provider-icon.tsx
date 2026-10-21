import React from 'react';
import { coerceRawSvgContent } from '@renderer/utils/mcp-icon-data';
import { htmlProp } from '@/lib/innerHtml';
import type { ModelProvider } from './model-provider';

/**
 * 厂商 logo。上游那版每一行左边都有一枚(见 `model-selector.tsx` 的 `ModelIcon`),
 * 而 `ModelOption.icon` 是**宿主给的 ReactNode** —— 本仓照同一个解剖:
 * `packages/session-ui` 够不到 `apps/desktop` 的图片资源,所以由这里渲染、经
 * `ComposerModelOption.icon` 传进去(与 `ComposerAgentOption.icon` 同一条路)。
 *
 * 图标全部取自 lobehub icons-static-svg 那一套(`session/assets/images/<key>.svg`,
 * 单色、`currentColor`、24 viewBox)。这里用 `import.meta.glob` **整目录扫**,
 * 所以新增一家只要把 svg 丢进那个目录 —— ❌ 没有第二处硬编码的映射表要同步。
 * ⇒「目录里没有图标字段所以做不了」是**错的**:缺的从来不是图片,是模型→厂商这条映射。
 *
 * ⚠️ 2026-09-18 补 `minimax` —— 它当初被漏掉,是因为 `ModelProvider.iconKey` 那时是可选的,
 * 于是「没配图标」是个合法状态,列表里别家有 logo、MiniMax 那行是个洞。现在 `iconKey` 必填。
 */

const svgs = import.meta.glob('../../../../assets/images/*.svg', { query: '?raw', eager: true });

const svgByKey = new Map(
  Object.entries(svgs)
    .map(([path, mod]) => [
      path
        .split('/')
        .pop()!
        .replace(/\.svg$/, ''),
      coerceRawSvgContent(mod),
    ])
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
);

/**
 * 把根 `<svg>` 撑满外层那个 14px 的盒子。
 *
 * ⚠️ ❌ 不复用 `prepareInlineSvgMarkup`:它注的是 Tailwind 的 `class="h-full w-full"`,
 * 而 **vitest 浏览器测试里 Tailwind 根本不落地**(实测,与「取证图不保真」是同一个坑)——
 * 它又同时把根节点的 `width`/`height` 剥掉,两件事叠起来 = 测试里这枚 svg 退回浏览器默认的
 * 300×150,一行被撑爆,而断言照样绿。⇒ 这里注**行内样式**,不依赖任何样式层。
 */
function inlineSvg(raw: string): string {
  const withoutSize = raw.replace(/<svg\b([^>]*)>/, (_m, attrs: string) => {
    const stripped = (attrs as string).replace(/\s(width|height)="[^"]*"/g, '');
    return `<svg${stripped}>`;
  });
  return withoutSize.replace('<svg', '<svg style="width:100%;height:100%;display:block"');
}

const markupByKey = new Map(
  [...svgByKey.entries()].map(([key, raw]) => [key, inlineSvg(raw)] as const)
);

/**
 * 认不出厂商、或这家厂商仓里没有图标 → 返回 `null`,那一行就不画图标位。
 * ❌ 不给一个通用占位:一枚人人都一样的灰方块既认不出厂商,又占掉了名字的横向空间。
 */
export function modelProviderIcon(provider: ModelProvider | null): React.ReactNode {
  if (!provider?.iconKey) return null;
  const markup = markupByKey.get(provider.iconKey);
  if (!markup) return null;
  return (
    <span
      role="img"
      aria-label={provider.name}
      data-provider-id={provider.id}
      style={{ display: 'block', width: '100%', height: '100%' }}
      dangerouslySetInnerHTML={htmlProp(markup)}
    />
  );
}
