/** @jsxImportSource solid-js */
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { summaryChip } from '@session-chat/components/primitives/summary-chip.css';
import { CollapseHeader } from '@session-chat/components/primitives/CollapseHeader';
import { IconError, IconShieldAlert } from '@session-chat/components/primitives/icons';
import { displayPath } from '@session-chat/lib/path';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { For, Show, createEffect, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import type { ChatFileOpToolCall, FileOpKind } from '@session-chat/model';
import {
  fileOpErrorIcon,
  fileOpPath,
  fileOpPathDir,
  fileOpPathName,
  fileOpOpenPath,
  fileOpPermissionIcon,
  fileOpVerb,
  fileRow,
  monoRunning,
} from './file-op.css';
import { fileOpCardVars } from './file-op.css';
import { ShimmerText } from '@session-chat/components/primitives/ShimmerText';
import { useChatTranslator } from '@session-chat/localization';

// ── Verb map ──────────────────────────────────────────────────────────────────

const VERB_KEY: Record<FileOpKind, string> = {
  read: 'transcript.read',
  edit: 'transcript.edited',
  delete: 'transcript.deleted',
  move: 'transcript.moved',
};

// ── Internal: FileRowItem ─────────────────────────────────────────────────────

function FileRowItem(props: {
  verb: string;
  path: string;
  lineH: number;
  onClick?: () => void;
  /** Status icon slot; rendered inside the row so the row is the only box. */
  trailing?: JSX.Element;
}) {
  // The row shows the path, not only its last segment: a batch of thirty files
  // can be thirty rows reading `index.ts`, differing only in the directory that
  // `basename` throws away. The kept levels are chosen without consulting the
  // width, so the row stays a single line measured by the same `rowH`.
  const parts = createMemo(() => displayPath(props.path));
  return (
    <div
      class={fileRow({ clickable: !!props.onClick })}
      style={{ height: `${props.lineH}px` }}
      role={props.onClick ? 'button' : undefined}
      onClick={props.onClick}
    >
      <span class={fileOpVerb}>{props.verb}</span>
      <span class={fileOpPath} title={props.path}>
        <Show when={parts().elided || parts().dir}>
          <span class={fileOpPathDir}>
            {parts().elided}
            {parts().dir}
          </span>
        </Show>
        <span class={fileOpPathName}>{parts().name}</span>
      </span>
      {props.trailing}
    </div>
  );
}

// ── Internal: status icon ─────────────────────────────────────────────────────

function FileOpStatus(props: { item: ChatFileOpToolCall }) {
  const translate = useChatTranslator();
  return (
    <Show
      when={props.item.awaitingPermission}
      fallback={
        <Show when={props.item.status === 'error'}>
          {/* 原因摆到行上,❌ 不再只靠悬浮在一颗小图标上的 title —— 那个 title 从前
              还永远是空的:`error` 这一格产品路径从没赋过值,只有 story 喂过(#4981)。
              和 tool / execute / subagent 戴同一颗片,不改行高;全文仍在 title 里。 */}
          <Show when={props.item.error}>
            {(reason) => (
              <span class={summaryChip} data-slot="tool-call-error" title={reason()}>
                {reason()}
              </span>
            )}
          </Show>
          <span
            class={fileOpErrorIcon}
            title={props.item.error ?? translate('transcript.failed')}
            aria-label={translate('transcript.error')}
          >
            <IconError />
          </span>
        </Show>
      }
    >
      <span
        class={fileOpPermissionIcon}
        title={translate('transcript.awaitingPermission')}
        aria-label={translate('transcript.awaitingPermission')}
      >
        <IconShieldAlert />
      </span>
    </Show>
  );
}

// ── FileOpRow (single-file) ───────────────────────────────────────────────────

export type FileOpRowProps = {
  item: ChatFileOpToolCall;
  rowH: number;
  collapsible?: boolean;
  expanded?: boolean;
};

/**
 * Without payload, the single-file branch is one line and one element. It used to be a
 * `singleOpRow` flex wrapper at `rowH` holding a `fileRow` at the same height —
 * two boxes expressing the same measurement, with the status icon parented to
 * the outer one.
 */
export function FileOpRow(props: FileOpRowProps) {
  const commands = useCommands();
  const translate = useChatTranslator();
  const verb = () => translate(VERB_KEY[props.item.op]);

  const openFile = (path: string) => {
    commands().onOpenFile?.({ path, itemId: props.item.id, source: 'file-op' });
  };
  const parts = createMemo(() => displayPath(props.item.ops[0]?.path ?? ''));

  return (
    <Show
      when={props.collapsible}
      fallback={
        <Show
          when={props.item.ops[0]}
          fallback={
            <div class={fileRow({ clickable: false })} style={{ height: `${props.rowH}px` }}>
              <ShimmerText
                class={monoRunning}
                active={props.item.status === 'running' && !props.item.awaitingPermission}
              >
                {verb()}…
              </ShimmerText>
              <FileOpStatus item={props.item} />
            </div>
          }
        >
          {(op) => (
            <FileRowItem
              verb={verb()}
              path={op().path}
              lineH={props.rowH}
              onClick={() => openFile(op().path)}
              trailing={<FileOpStatus item={props.item} />}
            />
          )}
        </Show>
      }
    >
      <CollapseHeader
        id={props.item.id}
        collapsible={true}
        expanded={Boolean(props.expanded)}
        active={props.item.status === 'running' && !props.item.awaitingPermission}
        error={props.item.status === 'error'}
        errorTitle={props.item.error}
        awaitingPermission={props.item.awaitingPermission}
        height={props.rowH}
        trailing={
          <Show when={props.item.ops[0]}>
            {(op) => (
              <button
                type="button"
                class={fileOpOpenPath}
                title={op().path}
                on:click={(event) => { event.stopPropagation(); openFile(op().path); }}
              >
                <span class={fileOpPathDir}>{parts().elided}{parts().dir}</span>
                <span class={fileOpPathName}>{parts().name}</span>
              </button>
            )}
          </Show>
        }
      >
        {verb()}
      </CollapseHeader>
    </Show>
  );
}

// ── FileOpHeader (multi-file header) ─────────────────────────────────────────

export type FileOpHeaderProps = {
  item: ChatFileOpToolCall;
  expanded: boolean;
  /** Whether the expanded file list shows more than the collapsed row already does. */
  collapsible: boolean;
  rowH: number;
};

export function FileOpHeader(props: FileOpHeaderProps) {
  const translate = useChatTranslator();
  return (
    <CollapseHeader
      id={props.item.id}
      collapsible={props.collapsible}
      expanded={props.expanded}
      active={props.item.status === 'running' && !props.item.awaitingPermission}
      error={props.item.status === 'error'}
      errorTitle={props.item.error}
      awaitingPermission={props.item.awaitingPermission}
      height={props.rowH}
    >
      {translate(VERB_KEY[props.item.op])}{' '}
      {translate('transcript.files', { count: props.item.ops.length })}
    </CollapseHeader>
  );
}

// ── FileOpList (expanded per-file list) ───────────────────────────────────────

export type FileOpListProps = {
  item: ChatFileOpToolCall;
  lineH: number;
  padY: number;
};

export function FileOpList(props: FileOpListProps) {
  const commands = useCommands();
  const translate = useChatTranslator();
  const verb = () => translate(VERB_KEY[props.item.op]);

  const openFile = (path: string) => {
    commands().onOpenFile?.({ path, itemId: props.item.id, source: 'file-op' });
  };

  return (
    <div
      style={{
        ...assignInlineVars({ [fileOpCardVars.padY]: `${props.padY}px` }),
        'padding-block': fileOpCardVars.padY,
      }}
    >
      <For each={props.item.ops}>
        {(op) => (
          <FileRowItem
            verb={verb()}
            path={op.path}
            lineH={props.lineH}
            onClick={() => openFile(op.path)}
          />
        )}
      </For>
    </div>
  );
}

// ── FileOpPreviewBody (streaming ops body inside ProjectWindow) ───────────────

export type FileOpPreviewBodyProps = {
  item: ChatFileOpToolCall;
  lineH: number;
  padY: number;
};

export function FileOpPreviewBody(props: FileOpPreviewBodyProps) {
  const translate = useChatTranslator();
  const verb = () => translate(VERB_KEY[props.item.op]);
  let innerEl: HTMLDivElement | undefined;

  createEffect(() => {
    const _n = props.item.ops.length; // reactive tracking
    if (innerEl) innerEl.scrollTop = innerEl.scrollHeight;
    return _n;
  });

  return (
    <div
      ref={(el) => {
        innerEl = el;
      }}
      style={{ height: '100%', 'overflow-y': 'auto', 'scrollbar-gutter': 'stable' }}
    >
      <div
        style={{
          ...assignInlineVars({ [fileOpCardVars.padY]: `${props.padY}px` }),
          'padding-block': fileOpCardVars.padY,
        }}
      >
        <For each={props.item.ops}>
          {(op) => <FileRowItem verb={verb()} path={op.path} lineH={props.lineH} />}
        </For>
      </div>
    </div>
  );
}
