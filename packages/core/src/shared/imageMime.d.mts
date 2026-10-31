export declare function normalizeMimeType(mimeType: string | null | undefined): string
export declare function mimeTypeFromName(fileName: string | null | undefined): string | null
export declare function extensionFromMimeType(mimeType: string | null | undefined): string | null
export declare const EXTENSION_ARCHIVE_MIME: 'application/vnd.gugu.extension+zip'
export declare function resolveAttachmentMimeType(fileName: string | null | undefined, declaredMimeType: string | null | undefined): string
export declare function isImageMimeType(mimeType: string | null | undefined): boolean
export declare function isRenderableImage(fileName: string | null | undefined, mimeType: string | null | undefined): boolean
