/** @jsxImportSource solid-js */
/**
 * ResourceLink — single-line renderer for ChatResourceLink rows.
 *
 * Layout (fixed single-line row, no border, no background, no inset):
 *   [resource || fileIcon] title path
 *
 * The icon is the file-type devicon when resolvable, else a generic resource
 * glyph. Title and path sit inline; the path keeps the muted secondary styling.
 * Clickable and opaque targets share one shape — clickability shows up only as
 * the cursor plus the hover colour/underline on the title, never as chrome.
 *
 * Click: workspace-file targets open in the editor via onOpenFile.
 *        external targets follow the URI in a new tab.
 *        opaque targets do nothing (URI is shown for copy).
 *
 * Outer geometry (height) is applied by resource-link.def.tsx Render.
 */

import type { MeasureCtx } from '@session-chat/core/define';
import { readableLabel, wrappedRowHeight } from '../readable-label';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { GenericFileIcon, IconError } from '@session-chat/components/primitives/icons';
import { resolveFileIconClass } from '@session-chat/lib/file-icons';
import { Show } from 'solid-js';
import type { ChatResourceLink, ResourceTarget } from '@session-chat/model';
import {
  iconWrap,
  pathText,
  rowClickable,
  rowStatic,
  sizeText,
  titleText,
} from './resource-link.css';
import { vars } from '@session-chat/styles/theme.css';
import { useChatTranslator } from '@session-chat/localization';

// ── Secondary label ─────────────────────────────────────────────────────────

export function secondaryLabel(uri: string, target: ResourceTarget): string {
  if (target.kind === 'workspace-file') {
    return target.path;
  }
  if (target.kind === 'external') {
    try {
      return new URL(target.url).hostname;
    } catch {
      return target.url;
    }
  }
  // opaque: show the scheme or the raw uri, capped
  return uri;
}

// ── Size formatting ─────────────────────────────────────────────────────────

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Component ────────────────────────────────────────────────────────────────

export function resourceLinkLayout(item: ChatResourceLink, ctx: MeasureCtx) {
  const available = Math.max(1, ctx.width - 25);
  const title = readableLabel(item.title ?? item.name, ctx, available, ctx.theme.config.roles.body.size, 20);
  const path = readableLabel(secondaryLabel(item.uri, item.target), ctx, available, 12, 18);
  const parts = [{ width: 17, height: 17 }, { width: Math.min(available, title.width), height: title.height }, { width: Math.min(available, path.width), height: path.height }];
  if (item.size !== undefined) parts.push({ width: readableLabel(formatSize(item.size), ctx).width, height: 18 });
  if (item.status === 'error') parts.push({ width: 17, height: 17 });
  return { title, path, available, height: Math.max(32, wrappedRowHeight(parts, ctx.width, 8, 4)) };
}

export type ResourceLinkProps = {
  item: ChatResourceLink;
  measureCtx: () => MeasureCtx;
};

export function ResourceLink(props: ResourceLinkProps) {
  const translate = useChatTranslator();
  const commands = useCommands();

  const layout = () => resourceLinkLayout(props.item, props.measureCtx());
  const iconName = () => {
    const name = props.item.name;
    return resolveFileIconClass(name) ?? null;
  };
  const isClickable = () => props.item.target.kind !== 'opaque';

  const handleClick = () => {
    const target = props.item.target;
    if (target.kind === 'workspace-file') {
      commands().onOpenFile?.({
        path: target.path,
        itemId: props.item.id,
        source: 'resource-link',
      });
    } else if (target.kind === 'external') {
      window.open(target.url, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div
      class={isClickable() ? rowClickable : rowStatic}
      style={{ height: '100%' }}
      onClick={isClickable() ? handleClick : undefined}
      role={isClickable() ? 'button' : undefined}
    >
      <div class={iconWrap}>
        <Show when={iconName()} fallback={<GenericFileIcon />}>
          <span class={iconName()!} />
        </Show>
      </div>
      <span class={titleText} style={{ width: `${Math.min(layout().available, layout().title.width)}px`, flex: 'none' }}>{layout().title.text}</span>
      <span class={pathText} style={{ width: `${Math.min(layout().available, layout().path.width)}px`, flex: 'none' }}>{layout().path.text}</span>
      <Show when={props.item.size !== undefined}>
        <span class={sizeText}>{formatSize(props.item.size!)}</span>
      </Show>
      <Show when={props.item.status === 'error'}>
        <span
          style={{ display: 'inline-flex', 'vertical-align': 'middle', color: vars.fgError }}
          title={props.item.error ?? translate('transcript.failed')}
          aria-label={translate('transcript.error')}
        >
          <IconError />
        </span>
      </Show>
    </div>
  );
}
