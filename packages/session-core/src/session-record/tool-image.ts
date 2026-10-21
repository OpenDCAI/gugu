import type { ToolImage, ToolNode, TranscriptItem, TranscriptTurn } from '../acp/client';
import { TOOL_IMAGE_FETCH_LIMIT } from './contract';

/** 手机取图时宿主的回答:找到的那张,或者说清是哪一样没有(手机上画的样子不一样)。 */
export type ToolImageLookup =
  | { ok: true; image: ToolImage }
  | { ok: false; code: 'no_such_item' | 'no_such_image' | 'too_large'; message: string };

function isToolNode(item: TranscriptItem): item is ToolNode {
  return item.kind !== 'message' && item.kind !== 'thinking';
}

function findNode(nodes: readonly ToolNode[], itemId: string): ToolNode | null {
  for (const node of nodes) {
    if (node.id === itemId) return node;
    const inChildren = node.children ? findNode(node.children, itemId) : null;
    if (inChildren) return inChildren;
  }
  return null;
}

/**
 * 时间线里某个工具条目交回来的第 `index` 张图(工具组里的子调用也找)。找不到如实说是哪一样没有:条目不在了
 * (记录被分叉、整份重读)和这一条没有那么多张是两回事,手机上画的样子不一样。
 */
export function findToolImage(turns: readonly TranscriptTurn[], itemId: string, index: number): ToolImageLookup {
  let node: ToolNode | null = null;
  for (const turn of turns) {
    node = findNode(turn.items.filter(isToolNode), itemId);
    if (node) break;
  }
  if (!node) return { ok: false, code: 'no_such_item', message: `no tool item ${itemId} in this session` };
  const images = node.kind === 'tool-group' ? undefined : node.images;
  const image = Number.isInteger(index) && index >= 0 ? images?.[index] : undefined;
  if (!image) return { ok: false, code: 'no_such_image', message: `tool item ${itemId} has ${images?.length ?? 0} pictures, not #${index}` };
  if (image.data.length > TOOL_IMAGE_FETCH_LIMIT) {
    return { ok: false, code: 'too_large', message: `picture #${index} is ${image.data.length} chars; over ${TOOL_IMAGE_FETCH_LIMIT}` };
  }
  return { ok: true, image };
}
