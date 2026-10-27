/**
 * MentionPill
 *
 * React NodeView for the TipTap `mention` atom node. Participant targets retain
 * their @ prefix without an avatar; file targets render
 * as a real pill with a file glyph (slash-command pill treatment) — the dropped-
 * folder path reference must read as an object, and its hover ✕ lives over the
 * icon slot only, never stretched across the text:
 *
 *   [icon] [name]
 *
 * On hover, a small ✕ button appears over the icon so the user can remove the
 * mention without keyboard navigation. The pill is `contentEditable=false`, so
 * Backspace / Delete at the node boundary deletes the entire atom at once.
 */

import { cx } from '@session-ui/styles/utilities/cx';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { File, X } from '../../../icons'
import type { MentionKind, MentionRole } from './types';
import * as styles from './mention-pill.css';

// ── Component ─────────────────────────────────────────────────────────────────

export function MentionPill({
  node,
  deleteNode,
}: NodeViewProps) {
  const label = (node.attrs.label as string | null) ?? (node.attrs.id as string | null) ?? '';
  const rawName = (node.attrs.name as string | null) ?? null;
  const name = rawName ?? label;
  const kind = ((node.attrs.kind as string | null) ?? 'custom') as MentionKind;
  const role = (node.attrs.role as MentionRole | null) ?? null;
  const engine = (node.attrs.engine as string | null)?.trim() || null;
  const isAgent = role === 'agent';
  // file 引用 = 斜杠命令 pill 同款:真 pill + 文件图标。旧的 bare-文本处理里 ✕ 覆盖层
  // (surfaceHover 色块)被拉满整枚 pill,悬浮时文字整段被吞(#5736 试玩反馈);✕ 只许盖图标位。
  const isFile = !isAgent && kind === 'file';
  const title = isAgent || isFile
    ? ((node.attrs.title as string | null)?.trim() || name)
    : null;
  const pending = node.attrs.pending === true;

  // Hover-x: overlaid over the icon area on pill-hover
  const removeBtn = (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        deleteNode();
      }}
      aria-label={`Remove @${name}`}
      className={styles.pillRemoveBtn}
    >
      <X style={{ width: '0.625rem', height: '0.625rem' }} />
    </button>
  );

  return (
    <NodeViewWrapper as="span" className={cx('mention-pill-wrapper', styles.pillWrapper)}>
      <span
        contentEditable={false}
        className={cx(
          styles.pill,
          isFile ? undefined : styles.pillPlain,
          pending && styles.pillPending,
        )}
        data-mention-id={node.attrs.id as string}
        data-mention-kind={kind}
        data-mention-role={role ?? undefined}
        data-mention-engine={engine ?? undefined}
        data-mention-title={title ?? undefined}
        data-mention-pending={pending || undefined}
        title={title ?? undefined}
      >
        {/* Icon area — relative so the ✕ overlay is positioned inside it */}
        {isFile ? (
          <span className={styles.pillIconArea}>
            <File aria-hidden style={{ width: '0.75rem', height: '0.75rem' }} />
            {removeBtn}
          </span>
        ) : (
          <span className={cx(styles.pillIconArea, styles.pillPlainIconArea)}>
            {/* Hover-x: for plain mentions, overlaid at the end of the text */}
            {removeBtn}
          </span>
        )}
        {/* Display name */}
        <span className={styles.pillName}>{kind === 'custom' ? '@' : ''}{name}</span>
        {node.attrs.annotation && <small data-mention-annotation="" className={styles.pillAnnotation}>{String(node.attrs.annotation)}</small>}
      </span>
    </NodeViewWrapper>
  );
}
