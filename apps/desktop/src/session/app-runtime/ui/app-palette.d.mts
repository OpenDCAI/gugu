// Types for app-palette.mjs (plain JS: vite.config.mts loads it directly — see its header).
/** Theme-dependent `--em-*` names and the gugu token each stands for. */
export declare const APP_PALETTE_COLORS: readonly (readonly [name: string, token: string])[]
/** Theme-independent `--em-*` scales and their tokens. */
export declare const APP_PALETTE_SCALES: readonly (readonly [name: string, token: string])[]
/** The `@layer gugu` palette block of ui.css, resolved from tokens.css. */
export declare function appPaletteCss(tokensCss: string): string
