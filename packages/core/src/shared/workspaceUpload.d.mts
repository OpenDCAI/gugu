export declare const WORKSPACE_TEXT_MAX_BYTES: number
export declare function workspaceUploadKind(
  fileName: string,
  mimeType: string | null | undefined,
  bytes: Uint8Array,
): { kind: 'document'; contentType: string; text: string } | { kind: 'file'; why: string }
export declare function jsonObjectProblem(
  text: string,
): null | { problem: 'invalid'; message: string } | { problem: 'not-object' }
