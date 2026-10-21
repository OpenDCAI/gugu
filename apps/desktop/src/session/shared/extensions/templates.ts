/**
 * The ready-made starts `app_create { template }` offers (friction F11). One list: the agent tool's schema and
 * the session-main side that writes them (extension-templates.ts) both read it.
 */
export const EXTENSION_TEMPLATES = ['group-json'] as const;
export type ExtensionTemplate = (typeof EXTENSION_TEMPLATES)[number];
