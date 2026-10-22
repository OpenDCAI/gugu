/** @jsxImportSource solid-js */
import { ShimmerText } from '@session-chat/components/primitives/ShimmerText';
import { useCaches } from '@session-chat/components/contexts/CachesContext';
import { summaryChip } from '@session-chat/components/primitives/summary-chip.css';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { cancelIdle, scheduleIdle } from '@session-chat/components/engine/dom-utils';
import { GenericFileIcon, IconError, IconShieldAlert } from '@session-chat/components/primitives/icons';
import { glyphIcon } from '@session-chat/components/primitives/icons.css';
import { applyTokensToElement } from '@session-chat/core/highlight/apply-tokens';
import type { CodeToken } from '@session-chat/core/highlight/highlighter';
import { resolveFileIconClass } from '@session-chat/lib/file-icons';
import { basename } from '@session-chat/lib/path';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { For, Show, createEffect, onCleanup } from 'solid-js';
import { useChatTranslator } from '@session-chat/localization';
import type { ChatDiff } from '@session-chat/model';
import type { DiffLayout } from './diff.def';
import {
  diffAddsCount,
  diffBodyCard,
  diffCardVars,
  diffDelsCount,
  diffErrorIcon,
  diffFileName,
  diffHeader,
  diffLineContent,
  diffPermissionIcon,
  diffRowClasses,
  diffPushRight,
  pdiffBody,
  pdiffLine,
} from './diff.css';

// ── DiffHeader ────────────────────────────────────────────────────────────────

export type DiffHeaderProps = {
  item: ChatDiff;
  adds: number;
  dels: number;
  headerH: number;
  /**
   * Whether a diff body is rendered below this header. Controls the border
   * shape: with a body the header owns the top + side edges and the separator
   * (`rounded-t`), standalone it owns the full rounded card border.
   */
  hasBody: boolean;
};

export function DiffHeader(props: DiffHeaderProps) {
  const translate = useChatTranslator();
  const name = () => basename(props.item.path);
  const iconClass = () => resolveFileIconClass(name());
  const running = () => props.item.status === 'running' && !props.item.awaitingPermission;
  // Stats are meaningless until a diff body exists; hide them while streaming
  // the header alone or when there are genuinely no changes.
  // A provider can stream the proposed diff before ACP permission is answered.
  // Counts are a claim that the change already happened, so keep them hidden
  // while the operation is awaiting approval.
  const showStats = () =>
    props.hasBody && !props.item.awaitingPermission && (props.adds > 0 || props.dels > 0);
  const commands = useCommands();

  const handleClick = () => {
    commands().onOpenFile?.({ path: props.item.path, itemId: props.item.id, source: 'diff' });
  };

  return (
    <div
      class={diffHeader({ hasBody: props.hasBody })}
      style={assignInlineVars({ [diffCardVars.headerH]: `${props.headerH}px` })}
      role="button"
      onClick={handleClick}
    >
      {iconClass() ? (
        <i class={`${iconClass()} ${glyphIcon} shrink-0`} aria-hidden="true" />
      ) : (
        <GenericFileIcon />
      )}
      <ShimmerText class={diffFileName} active={running()} title={props.item.path}>
        {name()}
      </ShimmerText>
      <Show when={showStats()}>
        <span class={diffAddsCount}>+{props.adds}</span>
        <span class={diffDelsCount}>−{props.dels}</span>
      </Show>
      <Show
        when={props.item.awaitingPermission}
        fallback={
          <Show when={props.item.status === 'error'}>
            {/* 原因摆到行上,❌ 不再只靠悬浮在一颗小图标上的 title —— 那个 title 从前
                还永远是空的:`error` 这一格产品路径从没赋过值,只有 story 喂过(#4981)。 */}
            <Show when={props.item.error}>
              {(reason) => (
                <span class={`${summaryChip} ${diffPushRight}`} data-slot="tool-call-error" title={reason()}>
                  {reason()}
                </span>
              )}
            </Show>
            <span
              class={diffErrorIcon}
              classList={{ [diffPushRight]: !props.item.error }}
              title={props.item.error ?? translate('transcript.failed')}
              aria-label={translate('transcript.error')}
            >
              <IconError />
            </span>
          </Show>
        }
      >
        <span
          class={`${diffPermissionIcon} ${diffPushRight}`}
          title={translate('transcript.awaitingPermission')}
          aria-label={translate('transcript.awaitingPermission')}
        >
          <IconShieldAlert />
        </span>
      </Show>
    </div>
  );
}

// ── DiffLines ─────────────────────────────────────────────────────────────────

export type DiffLinesProps = {
  item: ChatDiff;
  layout: DiffLayout;
  codeLineHeight: () => number;
};

export function DiffLines(props: DiffLinesProps) {
  const caches = useCaches();
  const lineEls = new Map<number, HTMLElement>();

  createEffect(() => {
    const { previewRows, lang } = props.layout;
    if (!previewRows.length || !lang) return;

    // Skip per-frame highlighting while the diff is still streaming in.
    // The effect tracks `props.item.status` reactively so it re-runs once
    // when status changes to 'done'/'error', running a single highlight then.
    if (props.item.status === 'running') return;

    const oldCode = props.item.oldText ?? '';
    const newCode = props.item.newText;

    function paint(newLines: CodeToken[][], oldLines: CodeToken[][]): void {
      for (let i = 0; i < previewRows.length; i++) {
        const row = previewRows[i];
        const el = lineEls.get(i);
        if (!row || !el) continue;

        let tokens: CodeToken[] | undefined;
        if (row.type === 'remove' && row.oldIdx !== undefined) {
          tokens = oldLines[row.oldIdx];
        } else if (row.newIdx !== undefined) {
          tokens = newLines[row.newIdx];
        }
        if (tokens) applyTokensToElement(el, tokens);
      }
    }

    const newHl = caches.peekHighlight(newCode, lang);
    const oldHl = props.item.oldText
      ? caches.peekHighlight(oldCode, lang)
      : { lines: [] as CodeToken[][], rootStyle: '' };
    if (newHl && oldHl) {
      paint(newHl.lines, oldHl.lines);
      return;
    }

    let cancelled = false;
    const handle = scheduleIdle(() => {
      if (cancelled) return;
      void Promise.all([
        caches.highlightWhenReady(newCode, lang),
        props.item.oldText ? caches.highlightWhenReady(oldCode, lang) : null,
      ]).then(([newResult, oldResult]) => {
        if (cancelled) return;
        paint(newResult?.lines ?? [], oldResult?.lines ?? []);
      });
    });

    onCleanup(() => {
      cancelled = true;
      cancelIdle(handle);
    });
  });

  // Geometry source of truth: each row is pinned to the exact line height that
  // diffDef.measure() reserved (theme.fonts.code.lineHeight). Applied inline so
  // the rendered height never drifts from the measured height via a CSS variable.
  const lineH = () => props.codeLineHeight();

  return (
    <div class={diffBodyCard}>
      <div class={pdiffBody}>
        <For each={props.layout.previewRows}>
          {(row, i) => (
            <div class={diffRowClasses[row.type]} style={{ height: `${lineH()}px` }}>
              <span
                ref={(el) => {
                  lineEls.set(i(), el);
                  onCleanup(() => lineEls.delete(i()));
                }}
                class={`${pdiffLine} ${diffLineContent}`}
                style={{ 'line-height': `${lineH()}px` }}
              >
                {row.text}
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

// ── Diff (legacy combined component for contract tests) ───────────────────────

/** @deprecated Use diffDef.Render via Project instead. Kept for open-file.contract.test.tsx. */
export type DiffProps = {
  item: ChatDiff;
  layout: DiffLayout;
  codeLineHeight: () => number;
};

export function Diff(props: DiffProps) {
  return (
    <div>
      <DiffHeader
        item={props.item}
        adds={props.layout.adds}
        dels={props.layout.dels}
        headerH={32}
        hasBody
      />
      <DiffLines item={props.item} layout={props.layout} codeLineHeight={props.codeLineHeight} />
    </div>
  );
}
