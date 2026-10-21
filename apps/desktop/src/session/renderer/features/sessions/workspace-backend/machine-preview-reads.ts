// #6264 别的机器上的网页 / HTML 预览要一块字节:主进程的 `gugu-preview://` 问过来(preview-protocol.ts),
// 这里经 `workspace.files.readChunk` 去那台机器取(rpc 按项目所在的机器路由),取到的原样(base64)回给主进程。
// 路径关在工作区里由那台机器核。
//
// 纯逻辑(事件收发与读那一块注入),单测钉:成功回块、失败回原因码、每一问都回(❌ 让主进程干等到超时)。
export type MachinePreviewReadRequest = {
  requestId: string;
  projectId: string;
  workspaceId: string;
  path: string;
  offset: number;
  length: number;
};

export type MachinePreviewReadResult = {
  requestId: string;
  chunk?: { size: number; etag: string | null; data: string };
  errorCode?: string;
};

export type MachinePreviewChunk = { size: number; etag: string | null; data: string };

export type MachinePreviewReadDeps = {
  onRequest: (handler: (request: MachinePreviewReadRequest) => void) => () => void;
  reply: (result: MachinePreviewReadResult) => void;
  /** 读一块;失败时抛出带 `code` 的错误(那台机器给的原因码)。 */
  read: (
    projectId: string,
    workspaceId: string,
    chunk: { path: string; offset: number; length: number }
  ) => Promise<MachinePreviewChunk>;
};

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : null;
}

/** 开始接主进程的取块请求;返回停止。 */
export function answerMachinePreviewReads(deps: MachinePreviewReadDeps): () => void {
  return deps.onRequest((request) => {
    void (async () => {
      try {
        const result = await deps.read(request.projectId, request.workspaceId, {
          path: request.path,
          offset: request.offset,
          length: request.length,
        });
        deps.reply({ requestId: request.requestId, chunk: { size: result.size, etag: result.etag, data: result.data } });
      } catch (error) {
        deps.reply({ requestId: request.requestId, errorCode: codeOf(error) ?? 'no_answer' });
      }
    })();
  });
}
