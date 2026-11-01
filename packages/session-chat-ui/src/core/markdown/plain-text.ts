/**
 * plain-text — extract a plain-text string from a Block.
 *
 * Used for a11y mirrors (sr-only) in message rows and for find-in-transcript.
 * Each block kind produces a human-readable string without markdown syntax or HTML.
 *
 * This module is PURE: no geometry, no pretext/fonts, no DOM imports.
 */

import type { Block } from './document';

export function blockPlainText(block: Block): string {
  switch (block.kind) {
    case 'html':
      return block.text;
    case 'code':
      return block.code;
    case 'mermaid':
    case 'svg':
      return block.source;
    case 'math':
      return block.tex;
  }
}
