import type {
  ListLocalSessionsParams,
  ListLocalSessionsResult,
  LocalSessionPreview,
  PreviewLocalSessionParams,
} from '@shared/core/session-import/session-import';

// @@@sessionpage 宿主注入口：本机会话的扫描与解析归 gugu 侧（packages/core 的
// transcriptInventory / sessionIndex）实现 —— 那份解析器要处理 Claude 的旁支 transcript、
// 机器注入的伪 user 记录、Codex 的注入前缀等一堆脏数据，由 sessionpage 独立导入链复用 core parser；
// 社交创建面已删除 transcript picker，不能再作为这份口径的 owner。
//
// 注入方式沿用既有惯例（setEmdashMcpInjector / setEmdashPtySessionpageHook）：宿主 boot 时塞进来，
// 会话页后端这侧只认这个接口。没注入就 fail loud —— 静默返回空清单会让用户以为「本机没有会话」。

export type LocalSessionSource = {
  list(params: ListLocalSessionsParams): Promise<ListLocalSessionsResult>;
  preview(params: PreviewLocalSessionParams): Promise<LocalSessionPreview>;
};

let source: LocalSessionSource | null = null;

export function setEmdashLocalSessionSource(next: LocalSessionSource | null): void {
  source = next;
}

export function getLocalSessionSource(): LocalSessionSource {
  if (!source) {
    throw new Error(
      '本机会话导入未接线：宿主没有调用 setEmdashLocalSessionSource（会话页无法扫描本机会话）'
    );
  }
  return source;
}

export function hasLocalSessionSource(): boolean {
  return source !== null;
}
