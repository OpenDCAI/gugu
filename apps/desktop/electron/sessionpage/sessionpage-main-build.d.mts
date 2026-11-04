// @@@4865 — declaration for sessionpage-main-build.mjs so gugu's root tsc (which typechecks
// vite.config.mts) can type the imports even though the sessionpage dir is excluded from the
// root program.
import type { Plugin } from 'vite'

export declare const EMDASH_EXTERNAL: string[]
export declare const SESSIONPAGE_NODE18_BANNER: string
export declare function sessionpageAssetPathPlugin(): Plugin
export declare function formidableGentlyStripPlugin(): Plugin
export declare function sessionpageResidualRequireGate(): Plugin
// 导出仅为伴随单测(合成 fixture 证闸可判假);生产路径只经 sessionpageResidualRequireGate 调用。
export declare function assertNoResidualRelativeRequires(outFile: string): void
