/**
 * SlashCommandPill
 *
 * React NodeView for the TipTap `slashCommand` atom node. Renders as an inline
 * pill containing the command name prefixed with its own sigil:
 *
 *   [/] [name]     ← bare ACP name
 *   [$] [name]     ← a name that carries its own sigil (codex skills)
 *
 * 前缀符号是从 `token` 首字符切出来的，与序列化读的是同一个字符串 —— 界面上写着 `$foo`、
 * 发出去却是 `/foo` 是这块最容易出的那种谎。
 *
 * On hover a small ✕ button appears so the user can remove the command without
 * keyboard navigation. Matches the visual treatment of MentionPill.
 */

import { cx } from '@session-ui/styles/utilities/cx';
import { fallbackToken, splitToken } from './command-token';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { X } from '../../../icons'
import React from 'react';
import * as styles from './mention-pill.css';

export function SlashCommandPill({ node, deleteNode }: NodeViewProps) {
  const token =
    (node.attrs.token as string | null)
    ?? fallbackToken((node.attrs.name as string | null) ?? (node.attrs.id as string | null) ?? '');
  const { sigil, label } = splitToken(token);

  return (
    <NodeViewWrapper as="span" className={cx('slash-command-pill-wrapper', styles.pillWrapper)}>
      <span
        contentEditable={false}
        className={styles.pill}
        data-slash-command-id={node.attrs.id as string}
      >
        {/* Slash prefix area — relative so the ✕ overlay is positioned inside it */}
        <span className={styles.pillIconArea} aria-hidden="true">
          <span className={styles.pillSigil}>{sigil}</span>
          {/* Hover-x: overlaid over the prefix on pill-hover */}
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              deleteNode();
            }}
            aria-label={`Remove ${sigil}${label}`}
            className={styles.pillRemoveBtn}
          >
            <X style={{ width: '0.625rem', height: '0.625rem' }} />
          </button>
        </span>
        {/* Command name */}
        <span className={styles.pillName}>{label}</span>
      </span>
    </NodeViewWrapper>
  );
}
