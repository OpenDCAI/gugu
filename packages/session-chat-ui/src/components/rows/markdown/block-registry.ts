import type { Block } from '@session-chat/core/markdown/document';
import type { BlockDef } from './block-def';
import { codeBlockDef } from './code/code.def';
import { htmlBlockDef } from './html/html.def';
import { mathBlockDef } from './math/math.def';
import { mermaidBlockDef } from './mermaid/mermaid.def';
import { svgBlockDef } from './svg/svg.def';

// registry boundary
export const BLOCK_REGISTRY: Record<Block['kind'], BlockDef<any, any>> = {
  html: htmlBlockDef,
  code: codeBlockDef,
  mermaid: mermaidBlockDef,
  svg: svgBlockDef,
  math: mathBlockDef,
};
