export declare const WORKSPACE_TEXT_MAX_BYTES: number
export declare const WORKSPACE_STORED_TEXT_MAX_BYTES: number
export declare function workspaceStoredText(
  fileName: string,
  mimeType: string | null | undefined,
  bytes: Uint8Array,
): { contentType: string; text: string; exact: boolean } | null
export declare function workspaceFileText(
  fileName: string,
  bytes: Uint8Array,
): { contentType: string; text: string; exact: boolean } | null
export declare function opensAsStoredText(
  fileName: string,
  mimeType: string | null | undefined,
  size: number | null,
): boolean
export declare function workspaceUploadKind(
  fileName: string,
  mimeType: string | null | undefined,
  bytes: Uint8Array,
): { kind: 'document'; contentType: string; text: string } | { kind: 'file'; why: string }
export declare function jsonObjectProblem(
  text: string,
): null | { problem: 'invalid'; message: string } | { problem: 'not-object' }
