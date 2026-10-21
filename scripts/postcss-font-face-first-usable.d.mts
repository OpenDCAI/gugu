import type { PluginCreator } from 'postcss'
export declare function firstUsableFontSrc(src: string): string | null
declare const fontFaceFirstUsable: PluginCreator<void>
export default fontFaceFirstUsable
