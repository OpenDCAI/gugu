/** @jsxImportSource solid-js */
/**
 * Tool — single-row renderer for generic ChatToolCall items, with a collapsible
 * request / result payload panel.
 *
 * Used as the desktop fallback for ACP tool kinds without a dedicated renderer
 * (search, fetch, mcp, other). Layout:
 *
 *   › Search  measure contract (4 matches)              ✓   ← header, rowH tall
 *     → {"pattern":"measure contract"}                      ← request section
 *     ← 4 matches in 3 files                                ← result section
 *
 * A failed call is announced by the mark alone until the row is opened; the
 * reason then leads the panel — see tool.layout for why that text is the result
 * field re-slotted rather than a channel of its own, and why it waits for a
 * click (owner, 2026-09-04):
 *
 *     › Fetch  https://example.invalid/ref              ⚠   ← closed: mark only
 *     ⌄ Fetch  https://example.invalid/ref              ⚠
 *       ! getaddrinfo ENOTFOUND example.invalid             ← failure section
 *
 * The anatomy is ported from upstream assistant-ui `elements-tool-call`
 * (chevron · shimmering active label · query · completion tick · request/result
 * panel) and re-expressed in Solid: the upstream component is React and its
 * Collapsible is a Base UI panel, neither of which the transcript can host. What
 * carries over verbatim is the `data-slot` vocabulary, so the same names are
 * addressable on both faces.
 *
 * Rows whose provider reported no payload stay exactly as they were — no
 * chevron, no toggle, no panel — because a disclosure control that reveals
 * nothing is a promise the row cannot keep.
 *
 * Shimmer applies while status === 'running'.
 *
 * Outer geometry (height, padding) is applied by tool.def.tsx Render; this
 * component only describes inner content.
 */

import { ShimmerText } from '@session-chat/components/primitives/ShimmerText';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { IconError, IconShieldAlert } from '@session-chat/components/primitives/icons';
import { applySoftWraps } from '@session-chat/core/measure/soft-wrap';
import { For, Show, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { observeAnimationViewport } from '@gugu/session-shared/animation-visibility';
import { useChatTranslator } from '@session-chat/localization';
import type { ChatToolCall } from '@session-chat/model';
import { chevron, chevronExpanded } from '@session-chat/components/primitives/collapse-header.css';
import type { ToolPayloadGeometry } from './tool.layout';
import type { ToolThumbStrip } from './tool-images';
import {
  toolChevronSlot,
  toolErrorIcon,
  toolName,
  toolPayloadError,
  toolPayloadLine,
  toolPayloadRequest,
  toolPayloadResult,
  toolPayloadSection,
  toolPermissionIcon,
  toolRow,
  toolRowCollapsible,
  toolSummary,
  toolThumb,
  toolThumbImage,
  toolThumbMore,
  toolThumbs,
} from './tool.css';

export type ToolProps = {
  item: ChatToolCall;
  /** True when the row has a payload and is therefore a disclosure control. */
  collapsible: boolean;
  expanded: boolean;
  /** The strip of pictures the call handed back (tool-images.ts); null when it handed none. */
  thumbs: ToolThumbStrip | null;
  /** Panel geometry for the current width; null while collapsed or empty. */
  payload: ToolPayloadGeometry | null;
  codeLineH: number;
};

export function ToolPayloadPanel(props: { payload: ToolPayloadGeometry; codeLineH: number }) {
  return (
    <For each={props.payload.sections}>
      {(section) => (
        <div
          class={toolPayloadSection}
          data-slot={`tool-call-${section.slot}`}
          style={{
            height: `${section.sectionH}px`,
            'overflow-y': section.contentH > section.sectionH ? 'auto' : 'hidden',
          }}
        >
          <For each={section.lines}>
            {(line) => (
              <div
                class={toolPayloadLine}
                classList={{
                  [toolPayloadRequest]: section.slot === 'request',
                  [toolPayloadResult]: section.slot === 'result',
                  [toolPayloadError]: section.slot === 'error',
                }}
                style={{
                  height: `${line.visualLineCount * props.codeLineH}px`,
                  'line-height': `${props.codeLineH}px`,
                }}
              >
                {applySoftWraps(line.text, line.softWrapOffsets)}
              </div>
            )}
          </For>
        </div>
      )}
    </For>
  );
}

export function Tool(props: ToolProps) {
  const translate = useChatTranslator();
  const isRunning = () => props.item.status === 'running' && !props.item.awaitingPermission;

  return (
    <>
      <div
        class={toolRow}
        classList={{ [toolRowCollapsible]: props.collapsible }}
        data-slot="tool-call-trigger"
        // Only payload-bearing rows are wired to the ChatRoot click delegation,
        // so a plain row cannot toggle a collapse state nothing would read.
        // Written as three attributes rather than one conditional spread: each
        // gets its own reactive binding this way, and `aria-expanded` has to
        // track every toggle — a spread evaluated once would freeze it at
        // whatever the row mounted as.
        data-collapse-id={props.collapsible ? props.item.id : undefined}
        role={props.collapsible ? 'button' : undefined}
        aria-expanded={props.collapsible ? (props.expanded ? 'true' : 'false') : undefined}
      >
        {/* The same chevron CollapseHeader draws, so a tool row and a thinking
            or execute header open with one motion rather than two near-misses. */}
        <Show when={props.collapsible}>
          <span class={toolChevronSlot} aria-hidden="true">
            <span class={chevron} classList={{ [chevronExpanded]: props.expanded }}>
              ›
            </span>
          </span>
        </Show>
        <ShimmerText class={toolName} active={isRunning()}>
          {props.item.name}
        </ShimmerText>
        <Show when={props.item.inputSummary}>
          <span class={toolSummary} data-slot="tool-call-query">
            {props.item.inputSummary}
          </span>
        </Show>
        {/* 右侧这一格只留**需要读者看一眼**的记号：出错、等授权。
            「做完了」不画记号（#4981，owner 2026-09-05 拍板去掉绿勾）——
            上游两个 element 在这一格上说的不是一件事：`elements-tool-call` 是
            「a checkmark once it settles」，而 `elements-tool-timeline` 每一步只有
            icon + verb + chip、**没有对勾**，靠「只有最后一步在 streaming 时微光，
            其余读作已完成」表达状态。gugu 的工具行两个身份都当：单独一行时是
            tool-call，折进「过程」里时是 timeline 的一步 —— 只能取一个，取 timeline。
            一屏十几个一模一样的绿勾信息量是零，还把真正要找的那个红记号淹了。
            ⇒「做完了」由「没有微光」表达（`toolName` 上的 textShimmer）。 */}
        <Show
          when={props.item.awaitingPermission}
          fallback={
            <Show when={props.item.status === 'error'}>
              {/* No `title`. The reason now has a measured section of its own,
                  and a native tooltip is the one thing on this row the theme
                  cannot touch — no token, no font, no radius — in a transcript
                  where everything else was drawn on purpose. It also required a
                  pointer to hover, so on a touch viewport it said nothing at
                  all; and what it said on desktop was `transcript.failed`, a
                  constant, because no ACP producer ever fills `error`. Dropping
                  it costs a reading that carried no information. The accessible
                  name stays: that one is read out, not hovered. */}
              <span
                class={toolErrorIcon}
                data-slot="tool-call-error-mark"
                aria-label={translate('transcript.error')}
              >
                <IconError />
              </span>
            </Show>
          }
        >
          <span
            class={toolPermissionIcon}
            title={translate('transcript.awaitingPermission')}
            aria-label={translate('transcript.awaitingPermission')}
          >
            <IconShieldAlert />
          </span>
        </Show>
      </div>
      <Show when={props.thumbs}>
        {(thumbs) => <ToolThumbs item={props.item} strip={thumbs()} />}
      </Show>
      <Show when={props.payload}>
        {(payload) => <ToolPayloadPanel payload={payload()} codeLineH={props.codeLineH} />}
      </Show>
    </>
  );
}

/**
 * The pictures the call handed back, as fixed boxes (tool-images.ts): the first `strip.shown` of them, the last box
 * saying how many more there are. A click opens the host's viewer on all of them from that one. Decoding is the
 * browser's business off the row's paint (`decoding=async`, `loading=lazy`): the box is already its final size.
 */
function ToolThumbs(props: { item: ChatToolCall; strip: ToolThumbStrip }) {
  const commands = useCommands();
  const translate = useChatTranslator();
  const count = () => props.item.imageCount ?? props.item.images?.length ?? 0;
  const [visible, setVisible] = createSignal(false);
  const [openFailed, setOpenFailed] = createSignal(false);
  let root!: HTMLDivElement;
  onMount(() => onCleanup(observeAnimationViewport(root, setVisible)));
  // Like committed attachment thumbnails, a Solid resource owns the fetched bytes.
  // The product's shared viewport observer delays fetching retained/offscreen rows.
  const [resolved] = createResource(
    () => visible() && { id: props.item.id, shown: props.strip.shown, images: props.item.images },
    ({ id, shown, images }) => Promise.all(Array.from({ length: shown }, (_, index) =>
      images?.[index] ?? commands().resolveToolImage?.(id, index) ?? null
    )).then(urls => ({ id, urls })),
  );
  const urlAt = (index: number) => props.item.images?.[index]
    ?? (resolved()?.id === props.item.id ? resolved()?.urls[index] ?? undefined : undefined);
  return (
    <div ref={root} class={toolThumbs} data-slot="tool-call-images" style={{ height: `${props.strip.stripH}px` }}>
      <For each={Array.from({ length: Math.min(count(), props.strip.shown) }, (_, index) => index)}>
        {(index) => (
          <button
            type="button"
            class={toolThumb}
            aria-label={translate('transcript.viewImage', { name: `${index + 1}/${count()}` })}
            title={openFailed() || (!resolved.loading && resolved() && !urlAt(index))
              ? translate('transcript.imageUnavailable') : undefined}
            data-image-state={urlAt(index) ? 'ready' : resolved.loading ? 'loading' : 'unavailable'}
            onClick={(e) => {
              const itemId = props.item.id;
              const thumb = e.currentTarget.querySelector('img') ?? undefined;
              const ready = Array.from({ length: count() }, (_, i) => urlAt(i));
              const open = (urls: (string | null | undefined)[]) => {
                if (props.item.id !== itemId) return;
                setOpenFailed(urls.some(url => !url));
                if (urls.some(url => !url)) return;
                commands().onViewImages?.({
                  urls: urls as string[], index, itemId, source: 'tool-result', thumb,
                });
              };
              if (ready.every(Boolean)) open(ready);
              else void Promise.all(ready.map((url, i) =>
                url ?? commands().resolveToolImage?.(itemId, i) ?? null
              )).then(open);
            }}
          >
            <img class={toolThumbImage} src={urlAt(index)} alt="" loading="lazy" decoding="async" />
            <Show when={props.strip.more > 0 && index === props.strip.shown - 1}>
              <span class={toolThumbMore} data-slot="tool-call-images-more">+{props.strip.more}</span>
            </Show>
          </button>
        )}
      </For>
    </div>
  );
}
