/**
 * Geometry types produced by the projected layout engine.
 *
 * These are plain data structures (no React, no MobX).
 * Leaf block layout types (Html, Code, Mermaid, Math) are consumed by their
 * block renderers and by BlockFrame for positioning.
 * They are also extended with a `raw` back-reference in BlockLeafLayout
 * (Project.tsx) so renderBlockLeaf can access source block data without a
 * separate lookup.
 *
 * Row-level layout aggregates (formerly MessageLayout) are now expressed as
 * compose trees (core/compose.ts) returned by each ComponentDef.measure().
 */

/** Code block with pre-positioned source lines. */
export type CodeLaidOut = {
  kind: 'code';
  id: string;
  top: number;
  height: number;
  /** Full effective width — code blocks always fill their allocated area. */
  contentWidth: number;
  lines: { top: number; text: string }[];
  lang?: string;
};

// ── Block leaf layout (produced by block-stack.ts) ────────────────────────────
//
// Extended leaf layout types that carry a back-reference to the source Block.
// Produced by `measureBlockCached` in `core/layout/block-stack.ts`.
// Used by `renderBlockLeaf` and `BlockStackView` to render without a lookup.

import type { CodeBlock, HtmlBlock, MathBlock, MermaidBlock } from '@session-chat/core/markdown/document';

/** Html block: its box was read from the DOM (components/rows/markdown/html/layout.ts). */
export type HtmlLeafLayout = {
  kind: 'html';
  id: string;
  top: number;
  height: number;
  /** Natural width (widest line, capped at the row width) — what the user pill hugs. */
  contentWidth: number;
  html: string;
  raw: HtmlBlock;
};

export type CodeLeafLayout = CodeLaidOut & { raw: CodeBlock };

/** Layout for a Mermaid diagram block — fixed 21:9 aspect-ratio preview. */
export type MermaidLaidOut = {
  kind: 'mermaid';
  id: string;
  top: number;
  height: number;
  contentWidth: number;
  source: string;
};

export type MermaidLeafLayout = MermaidLaidOut & { raw: MermaidBlock };

/**
 * Layout for a display-math block — height comes from typesetting the formula
 * offscreen, so the reserved box and the painted box are the same measurement.
 */
export type MathLaidOut = {
  kind: 'math';
  id: string;
  top: number;
  height: number;
  contentWidth: number;
  /** KaTeX HTML for the formula — produced by the same call that measured it. */
  html: string;
  /** Natural typeset width in px; exceeds contentWidth for over-wide formulas. */
  naturalWidth: number;
  /** Font size the formula was typeset at, applied inline so render == measure. */
  fontSize: number;
};

export type MathLeafLayout = MathLaidOut & { raw: MathBlock };

export type BlockLeafLayout = HtmlLeafLayout | CodeLeafLayout | MermaidLeafLayout | MathLeafLayout;
