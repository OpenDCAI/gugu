/**
 * document — the transcript's parsed markdown (output of core/markdown/parse.ts).
 *
 * Text of every kind is an `html` block: sanitized markup from the shared dialect
 * (@gugu/session-shared/markdown/dialect), styled by the shared `.gg-md` typography
 * and measured in the DOM. Code, display math, mermaid and svg keep kinds of their
 * own because their boxes are their own (highlighter rows, a typeset formula, a
 * fixed-aspect diagram).
 *
 * This module is PURE: no geometry, no DOM imports.
 */

/** Stable ID format: `${messageId}#${blockIndex}` */
export type BlockId = string;

/** A run of top-level markdown nodes rendered as sanitized HTML. */
export type HtmlBlock = {
  kind: 'html';
  id: BlockId;
  html: string;
  /** What a reader sees, for screen readers and find-in-transcript. */
  text: string;
  /** A literal `**` is still waiting for its closing pair (streaming holds the block back). */
  pendingStrong?: boolean;
  /** Headings read as body text (reasoning rows). */
  flat?: boolean;
};

/**
 * A fenced or indented code block.
 * Height is computed via: `lines.length * CODE_LINE_HEIGHT + 2 * CODE_BLOCK_PAD_Y`.
 */
export type CodeBlock = {
  kind: 'code';
  id: BlockId;
  /** Raw source code. */
  code: string;
  /** Optional language hint (e.g. "typescript"). */
  lang?: string;
};

/**
 * A fenced Mermaid diagram (` ```mermaid `).
 * Rendered as a clickable 21:9 SVG preview via official mermaid.
 */
export type MermaidBlock = {
  kind: 'mermaid';
  id: BlockId;
  /** Raw Mermaid source text. */
  source: string;
};

/**
 * A fenced SVG figure (` ```svg `), drawn as an image at its viewBox size
 * (core/svg/figure.ts); one that cannot be drawn is painted as code.
 */
export type SvgBlock = {
  kind: 'svg';
  id: BlockId;
  /** Raw SVG source text. */
  source: string;
};

/**
 * A display LaTeX block (`$$…$$`), typeset by KaTeX in display mode.
 *
 * Like Mermaid, its height cannot be derived from a formula — it depends on the
 * real typeset result (script depth, fraction nesting, delimiter growth). Unlike
 * Mermaid it is not given an arbitrary aspect ratio: the measurement tier
 * typesets it offscreen and reports the exact box.
 */
export type MathBlock = {
  kind: 'math';
  id: BlockId;
  /** Raw LaTeX source text. */
  tex: string;
};

export type Block = HtmlBlock | CodeBlock | MermaidBlock | SvgBlock | MathBlock;
