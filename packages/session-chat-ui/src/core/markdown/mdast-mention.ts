import type { MentionKind, MentionSyntax } from '@gugu/session-shared/markdown';
/**
 * MdastMention — custom mdast node produced by the `remarkInlineMentions`
 * transform plugin.
 *
 * The plugin folds `@[label](target)` link nodes and splits `@bare` / `/command`
 * text spans into these nodes so `treeToBlocks` can project them as chips
 * without re-running regex scanning.
 */
import type { Node } from 'unist';

export interface MdastMention extends Node {
  type: 'mention';
  /** Which grammar form produced this node. */
  syntax: MentionSyntax;
  /** Display text shown in the pill (basename for file mentions). */
  label: string;
  /** Stable path/id for click-to-open (the link URL for bracket form). */
  target?: string;
  /** Short name override — same as label in most cases. */
  name?: string;
  /** Semantic category for pill icon and color. */
  mentionKind?: MentionKind;
  /** Session title used by local-agent mention hover details. */
  title?: string;
  /** Harness identity used by local-agent mention DOM consumers. */
  engine?: string;
  /** Optional devicon CSS class for the pill icon. */
  iconClass?: string;
  /** Optional host icon image URL for the pill icon. */
  iconUrl?: string;
  /** Tone override — 'command' for slash chips. */
  tone?: string;
}
