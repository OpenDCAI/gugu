"use client";

import type { ComponentProps } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export const paper = "bg-background border border-border/60 dark:bg-popover";

export const floating = "bg-background border border-border/60 dark:bg-popover";

export const field = "bg-foreground/[0.04] dark:bg-foreground/[0.06]";

export const fieldInteractive =
  "bg-foreground/[0.04] transition-colors hover:bg-foreground/[0.07] dark:bg-foreground/[0.06] dark:hover:bg-foreground/[0.09]";

export const pressable =
  "transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.96] motion-reduce:transition-none";

export const ghostButton =
  "flex items-center justify-center rounded-full text-foreground/45 outline-none transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.06] hover:text-foreground/90 active:scale-[0.96] focus-visible:ring-1 focus-visible:ring-foreground/20 motion-reduce:transition-none dark:hover:bg-foreground/[0.09]";

export const inkButton =
  "bg-foreground text-background transition-[opacity,scale] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:opacity-90 active:scale-[0.96] motion-reduce:transition-none";

export const iconSwap =
  "[grid-area:1/1] transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none";

export const iconSwapIn = "scale-100 opacity-100 blur-none";

export const iconSwapOut = "scale-[0.25] opacity-0 blur-[4px]";

export const labelSwap =
  "col-start-1 row-start-1 flex w-max items-center gap-1.5 leading-none transition-[opacity,filter] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none";

export const labelSwapIn = "opacity-100 blur-none";

export const labelSwapOut =
  "pointer-events-none select-none opacity-0 blur-[2px]";

export const collapsePanel =
  "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] data-[ending-style]:h-0 data-[starting-style]:h-0 motion-reduce:transition-none";

/**
 * design.md 的唯一 accent:streaming / running / connected / currently selected。
 * @@@live-accent (Refs #6105) —— 原来写死 `text-blue-500 dark:text-blue-400`,且全仓 0 消费点。
 * 现在消费 tokens.css 的 `--live`(亮 blue-500 / 暗 blue-400 同一档),并真正接到运行态上。
 */
// @@@live-accent (Refs #6104) — tokens.css 的 @theme 现在登记了 --color-live ⇒ `text-live`
// 是真 utility,不必再写任意值。会话页那半边(session/renderer/lib/ui/assistant-ui/surfaces.tsx)
// 一直就是这么写的,两半边从此同一个拼写。
export const live = "text-live";

export const mono = "font-mono text-[length:var(--font-caption)] tracking-tight";

export function ShimmerLabel({
  active = true,
  className,
  ...props
}: ComponentProps<"span"> & { active?: boolean }) {
  return (
    <span
      className={cn(active && "shimmer motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

/**
 * Scroll region for content that keeps its own whitespace. `whitespace-pre` in
 * a bounded box clips a long line with no way to reach it, so the rows scroll
 * instead.
 *
 * `codeSurface` wraps all the rows as one block, and the rows are its children.
 * It cannot go on each row: `min-width: 100%` resolves against the scroll
 * container's visible width rather than its scroll width, so a per-row width
 * leaves every row except the longest ending its background at the fold.
 */
export const codeScroll = "overflow-x-auto";

export const codeSurface = "w-max min-w-full";

export function SwapLabel({
  active,
  children,
  className,
}: {
  active: 0 | 1;
  children: [React.ReactNode, React.ReactNode];
  className?: string;
}) {
  const layers = [useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null)];
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const target = layers[active]?.current;
    if (!target) return undefined;
    const measure = () =>
      setWidth(Math.ceil(target.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [active]);

  return (
    <span
      style={width === null ? undefined : { width }}
      className={cn(
        "grid overflow-x-clip transition-[width] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
        className,
      )}
    >
      {children.map((layer, index) => (
        <span
          key={index}
          ref={layers[index]}
          aria-hidden={active !== index}
          className={cn(
            labelSwap,
            active === index ? labelSwapIn : labelSwapOut,
          )}
        >
          {layer}
        </span>
      ))}
    </span>
  );
}
