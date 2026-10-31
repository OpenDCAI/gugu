/** @jsxImportSource solid-js */
import { summaryChip } from '@session-chat/components/primitives/summary-chip.css';
import { useChatTranslator } from '@session-chat/localization';
import { ShimmerText } from '@session-chat/components/primitives/ShimmerText';
import { useCaches } from '@session-chat/components/contexts/CachesContext';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { GenericFileIcon, IconError, IconShieldAlert } from '@session-chat/components/primitives/icons';
import { applyTokensToElement } from '@session-chat/core/highlight/apply-tokens';
import { basename } from '@session-chat/lib/path';
import { For, Show, createEffect, onCleanup } from 'solid-js';
import { changedFilePath } from '@gugu/session-core/acp';
import type { ChatDiff } from '@session-chat/model';
import type { DiffLayout, PatchLayout } from './diff.def';
import { diffBodyVisible } from './diff-visibility';
import * as css from './diff.css';

export type DiffHeaderProps = { item: ChatDiff; section?: PatchLayout; headerH: number; hasBody: boolean };
export function DiffHeader(props: DiffHeaderProps) {
  const commands = useCommands();
  const translate = useChatTranslator();
  const running = () => props.item.status === 'running' && !props.item.awaitingPermission;
  const stats = () => props.hasBody && !props.item.awaitingPermission && props.section?.adds !== null && props.section?.dels !== null && ((props.section?.adds ?? 0) > 0 || (props.section?.dels ?? 0) > 0);
  return <div class={css.diffHeader({ hasBody: props.hasBody })} style={{ height: `${props.headerH}px` }} data-patch-scope={props.section?.patch.scope}>
    <GenericFileIcon />
    <For each={props.section?.patch.changes ?? []}>{change => {
      const path = () => changedFilePath(change);
      const label = () => ('oldPath' in change && typeof change.oldPath === 'string' ? `${basename(change.oldPath)} → ` : '') + (path() ? basename(path()!) : change.operation);
      return <button type="button" class={css.diffFileName} title={path()} data-patch-path={path()} disabled={!path() || !commands().onOpenFile} onClick={() => {
        const target = path(); if (target) commands().onOpenFile?.({ path: target, itemId: props.item.id, source: 'diff' });
      }}><ShimmerText active={running()}>{label()}</ShimmerText></button>;
    }}</For>
    <Show when={stats()}><span class={css.diffAddsCount}>+{props.section?.adds}</span><span class={css.diffDelsCount}>−{props.section?.dels}</span></Show>
    <Show when={props.item.awaitingPermission} fallback={<Show when={props.item.status === 'error'}>
      <Show when={props.item.error}>{reason => <span class={`${summaryChip} ${css.diffPushRight}`} data-slot="tool-call-error" title={reason()}>{reason()}</span>}</Show>
      <span class={css.diffErrorIcon} classList={{ [css.diffPushRight]: !props.item.error }} title={props.item.error ?? translate('transcript.failed')} aria-label={translate('transcript.error')}><IconError /></span>
    </Show>}><span class={`${css.diffPermissionIcon} ${css.diffPushRight}`} title={translate('transcript.awaitingPermission')} aria-label={translate('transcript.awaitingPermission')}><IconShieldAlert /></span></Show>
  </div>;
}

export type DiffLinesProps = { item: ChatDiff; layout: PatchLayout; codeLineHeight: () => number };
export function DiffLines(props: DiffLinesProps) {
  const caches = useCaches();
  const elements = new Map<number, HTMLElement>();
  createEffect(() => {
    if (props.item.status === 'running' || !props.layout.lang) return;
    let cancelled = false;
    for (const [index, row] of props.layout.previewRows.entries()) {
      if (row.type === 'meta' || row.type === 'hunk') continue;
      void caches.highlightWhenReady(row.text, props.layout.lang).then(result => {
        const el = elements.get(index);
        if (!cancelled && el && result?.lines[0]) applyTokensToElement(el, result.lines[0]);
      });
    }
    onCleanup(() => { cancelled = true; });
  });
  return <div class={css.diffBodyCard}><div class={css.pdiffBody}>
    <For each={props.layout.previewRows}>{(row, index) => <div class={css.diffRowClasses[row.type]} style={{ height: `${props.codeLineHeight()}px` }} data-patch-row={row.type} data-old-line={row.oldIdx === undefined ? undefined : row.oldIdx + 1} data-new-line={row.newIdx === undefined ? undefined : row.newIdx + 1}>
      <span class={`${css.pdiffLine} ${css.diffLineContent}`} style={{ 'line-height': `${props.codeLineHeight()}px` }} ref={el => { elements.set(index(), el); onCleanup(() => elements.delete(index())); }}>{row.text}</span>
    </div>}</For>
    <Show when={props.layout.truncated}><div style={{ height: `${props.codeLineHeight()}px`, 'line-height': `${props.codeLineHeight()}px` }}>…</div></Show>
  </div></div>;
}

export type DiffProps = { item: ChatDiff; layout: DiffLayout; codeLineHeight: () => number; headerH: number };
/** The same patch presentation serves live, settled and direct contract mounts. */
export function Diff(props: DiffProps) {
  return <Show when={props.layout.sections.length} fallback={<DiffHeader item={props.item} headerH={props.headerH} hasBody={false} />}>
    <For each={props.layout.sections}>{section => <>
      <DiffHeader item={props.item} section={section} headerH={props.headerH} hasBody={diffBodyVisible(props.item) && section.previewRows.length > 0} />
      <Show when={diffBodyVisible(props.item)}><DiffLines item={props.item} layout={section} codeLineHeight={props.codeLineHeight} /></Show>
    </>}</For>
  </Show>;
}
