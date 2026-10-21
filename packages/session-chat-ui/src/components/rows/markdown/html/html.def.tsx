/** @jsxImportSource solid-js */
/**
 * html — text rendered by the shared markdown dialect, measured in the DOM.
 *
 * The painted element carries the same classes, font and width as the offscreen
 * measurement (layout.ts), so `measure()` equals the painted height. What the
 * paint adds on top never moves a box:
 *  - mention icons fill a fixed-size slot the measurement already reserved;
 *  - streaming fades the text appended since the last paint (opacity only);
 *  - code nested inside a list or quote is coloured in place (monospace, no wrap).
 */

import { useCaches } from '@session-chat/components/contexts/CachesContext';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { useStreamAnimation } from '@session-chat/components/contexts/StreamContext';
import { useTheme } from '@session-chat/components/contexts/ThemeContext';
import { BlockFrame } from '@session-chat/components/engine/block-frame';
import { MentionAtIcon, MentionFileIcon, MentionIssueIcon, MentionSymbolIcon } from '@session-chat/components/primitives/icons';
import { glyphIcon } from '@session-chat/components/primitives/icons.css';
import { defineBlock } from '@session-chat/components/rows/markdown/block-def';
import type { ChatCaches } from '@session-chat/core/caches';
import { paintHighlight } from '@session-chat/core/highlight/highlighter';
import type { Measured, MeasureCtx } from '@session-chat/core/define';
import type { HtmlLeafLayout } from '@session-chat/core/layout/layout-types';
import type { HtmlBlock } from '@session-chat/core/markdown/document';
import { onCleanup, onMount } from 'solid-js';
import { render } from 'solid-js/web';
import { applyBodyType, htmlBlockClass, measureHtml } from './layout';

const KIND_ICONS = { file: MentionFileIcon, issue: MentionIssueIcon, symbol: MentionSymbolIcon } as const;
type MentionKind = 'file' | 'issue' | 'symbol' | 'custom';

function hydrateMentionIcons(root: HTMLElement): () => void {
  const disposers: (() => void)[] = [];
  for (const slot of root.querySelectorAll<HTMLElement>('.gg-md-mention-icon')) {
    const { icon, iconUrl, iconClass } = slot.dataset;
    if (icon === 'url' && iconUrl) {
      const img = document.createElement('img');
      img.src = iconUrl;
      img.alt = '';
      slot.appendChild(img);
    } else if (icon === 'class' && iconClass) {
      const glyph = document.createElement('i');
      glyph.className = `${iconClass} ${glyphIcon}`;
      slot.appendChild(glyph);
    } else {
      const Icon = KIND_ICONS[icon as keyof typeof KIND_ICONS] ?? MentionAtIcon;
      disposers.push(render(() => <Icon />, slot));
    }
  }
  return () => disposers.forEach((dispose) => dispose());
}

/** Wraps the text past `from` characters in a fading span; returns the block's character count. */
function fadeFreshText(root: HTMLElement, from: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('.katex, .gg-md-mention') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const texts: { node: Text; start: number }[] = [];
  let offset = 0;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    texts.push({ node, start: offset });
    offset += node.data.length;
  }
  for (const { node, start } of texts) {
    if (start + node.data.length <= from) continue;
    const fresh = from > start ? node.splitText(from - start) : node;
    if (!fresh.data.trim()) continue;
    const span = document.createElement('span');
    span.className = 'gg-md-fresh';
    fresh.replaceWith(span);
    span.appendChild(fresh);
  }
  return offset;
}

function highlightNestedCode(root: HTMLElement, caches: ChatCaches): void {
  for (const code of root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
    const lang = /language-(\S+)/.exec(code.className)?.[1];
    if (!lang) continue;
    void caches.highlightWhenReady(code.textContent ?? '', lang).then((result) => {
      if (result && code.isConnected) paintHighlight(code, result);
    });
  }
}

function HtmlBlockView(props: { node: Measured<HtmlLeafLayout> }) {
  const commands = useCommands();
  const caches = useCaches();
  const stream = useStreamAnimation();
  const theme = useTheme();
  let root!: HTMLDivElement;

  onMount(() => {
    const layout = props.node.layout;
    applyBodyType(root, theme());
    root.innerHTML = layout.html;
    onCleanup(hydrateMentionIcons(root));
    highlightNestedCode(root, caches);
    if (stream) stream.frontier.set(layout.id, fadeFreshText(root, stream.frontier.get(layout.id) ?? 0));
  });

  const onClick = (event: MouseEvent) => {
    const target = event.target as Element;
    const mention = target.closest<HTMLElement>('.gg-md-mention[data-mention-kind]');
    if (mention) {
      // A file pill is read the way a link is (App 引用 pill, 148 17:03): one pointing at a group's file — `gugu-file://`,
      // maybe with a place — opens there, as that link's click does; only a path on this computer is the host's file.
      const groupFile = mention.dataset.mentionKind === 'file' ? commands().classifyLink?.(mention.dataset.mentionId ?? '') : undefined;
      if (groupFile?.kind === 'group-file') {
        commands().onOpenGroupFile?.({ itemId: groupFile.itemId, ...(groupFile.at ? { at: groupFile.at } : {}) });
        return;
      }
      commands().onClickMention?.({
        id: mention.dataset.mentionId ?? '',
        label: mention.dataset.mentionLabel ?? mention.textContent ?? '',
        kind: mention.dataset.mentionKind as MentionKind,
        itemId: props.node.layout.id,
        source: 'prose-mention',
      });
      return;
    }
    const link = target.closest<HTMLAnchorElement>('a[href]');
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#')) return;
    const kind = commands().classifyLink?.(href);
    if (kind?.kind === 'conversation') {
      commands().onOpenConversationLink?.(kind.href);
      return;
    }
    if (kind?.kind === 'workspace-file') {
      commands().onOpenFile?.({ path: kind.path, itemId: props.node.layout.id, source: 'prose-link', ...(kind.at ? { at: kind.at } : {}) });
      return;
    }
    if (kind?.kind === 'group-file') {
      commands().onOpenGroupFile?.({ itemId: kind.itemId, ...(kind.at ? { at: kind.at } : {}) });
      return;
    }
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  return (
    <BlockFrame layout={props.node.layout}>
      <div ref={root} class={htmlBlockClass(props.node.layout.raw)} onClick={onClick} />
    </BlockFrame>
  );
}

export const htmlBlockDef = defineBlock<HtmlBlock, HtmlLeafLayout>({
  kind: 'html',
  margin: () => ({ top: 6, bottom: 6 }),

  measure(block: HtmlBlock, ctx: MeasureCtx): Measured<HtmlLeafLayout> {
    const width = Math.max(1, ctx.width);
    const metrics = measureHtml(block, width, ctx.theme);
    const layout: HtmlLeafLayout = {
      kind: 'html',
      id: block.id,
      top: 0,
      height: metrics.height,
      contentWidth: metrics.width,
      html: block.html,
      raw: block,
    };
    return { height: metrics.height, width: metrics.width, layout };
  },

  Render: HtmlBlockView,
});
