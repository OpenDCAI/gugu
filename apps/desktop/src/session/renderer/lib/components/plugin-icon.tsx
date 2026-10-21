import { useSyncExternalStore } from 'react';
import { readHostTheme, subscribeToHostTheme } from '@renderer/lib/theme/host-theme';
import { cn } from '@renderer/utils/utils';
import { htmlProp } from '@/lib/innerHtml';
import type { AgentIconAsset } from '@shared/core/agents/agent-payload';
import { pickIconVariant } from './agent-icon-variant';

type PluginIconProps = {
  id: string;
  icon: AgentIconAsset;
  size?: number;
  className?: string;
  grayscale?: boolean;
  /**
   * Render as if the app were in this theme. An app-icon plate (`AppIcon`) does not change with
   * the theme, so the mark on it must not switch to its dark art or invert either.
   */
  theme?: 'light' | 'dark';
};

export function PluginIcon({ id, icon, size = 16, className, grayscale, theme }: PluginIconProps) {
  // 读主题的真值(host-theme 那份存储,ThemeProvider 自己读的也是它),❌ 经会话页的 ThemeContext:
  // 图标也画在会话页那棵树外面(设置弹窗里的「订阅」页),那里没有 ThemeProvider,经 context 读会整页抛错。
  const effectiveTheme = useSyncExternalStore(subscribeToHostTheme, readHostTheme, readHostTheme);
  const mode = theme ?? (effectiveTheme === 'emdark' ? 'dark' : 'light');
  const variant = pickIconVariant(icon.variants, size);
  if (!variant) return null;

  const shouldInvert = mode === 'dark' && icon.invertInDark;
  const content = mode === 'dark' && variant.dark ? variant.dark : variant.light;

  // @@@plugin-icon-size — 两个 `!` 不是保险,是必需的。
  //
  // 插件给的是**裸 svg**(没有任何 class),而 session-ui 有一条全局兜底
  // `.svgDefaultSize svg:not([class*="size-"]) { width:1rem; height:1rem }`
  // (packages/session-ui/src/styles/effects/svg-helpers.css.ts)。它的特异性是 (0,2,1),
  // 高于 `[&>svg]:h-full` 编译出来的 (0,1,1) —— 于是 svg 被钉死 16px,
  // 而外面这层 wrapper 是调用方给的尺寸(常见 14px)。
  // 结果:图标比自己的盒子大,从盒子里溢出来 —— owner 2026-09-07 圈的「图标怎么感觉有点…飘」。
  // 真机量过:字形 16.5px、周围文字 cap height 9.5px。
  //
  // ⚠️ 判据只能是真机量 computed width。源码读起来两边都写着尺寸,画出来才知道谁赢。
  //
  // `[&>svg]:pointer-events-none`:插件 svg 常自带 `<title>`(Claude / OpenAI …),指针落在字形上
  // 就弹原生提示,而这枚图标常被包进产品自己的 Tooltip(侧栏会话行的引擎名)⇒ 同一次悬停弹两个。
  // 字形不做命中目标,悬停落到 wrapper,由外层决定弹什么;读屏仍读得到 `<title>`。
  const wrapperClass = cn(
    'inline-flex shrink-0 items-center justify-center [&>svg]:!h-full [&>svg]:!w-full [&>svg]:pointer-events-none',
    grayscale && 'grayscale',
    shouldInvert && 'invert',
    className
  );

  if (icon.kind === 'image') {
    return (
      <span className={wrapperClass} style={{ width: size, height: size }}>
        <img src={content} alt={icon.alt ?? id} width={size} height={size} />
      </span>
    );
  }

  return (
    <span
      className={wrapperClass}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={htmlProp(content)}
    />
  );
}
