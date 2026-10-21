import type { Block } from '@session-chat/core/markdown/document';
import type { BlockDef } from './block-def';
import { codeBlockDef } from './code/code.def';
import { htmlBlockDef } from './html/html.def';
import { mathBlockDef } from './math/math.def';
import { mermaidBlockDef } from './mermaid/mermaid.def';

// oxlint-disable-next-line typescript/no-explicit-any -- registry boundary
export const BLOCK_REGISTRY: Record<Block['kind'], BlockDef<any, any>> = {
  html: htmlBlockDef,
  code: codeBlockDef,
  mermaid: mermaidBlockDef,
  math: mathBlockDef,
};
