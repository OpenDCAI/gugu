/**
 * Grammars the default chat highlighter fetches on first use — all of them (LAZY_LANG_LOADERS in
 * highlighter.ts is typed against this list, so the two cannot drift).
 *
 * Dependency-free on purpose: vite.config.mts and vitest.config.ts import it to
 * pre-declare these modules in `optimizeDeps.include`. A bare-module dynamic import
 * that Vite first meets at runtime triggers "new dependencies optimized → reloading",
 * which in the dev app is the session-page exit path described at @@@4865, and in the
 * browser test projects reloads the page mid-file (PR #6568 CI).
 */
export const LAZY_LANG_IDS = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'diff',
  'docker',
  'go',
  'html',
  'java',
  'javascript',
  'json',
  'jsx',
  'kotlin',
  'markdown',
  'php',
  'python',
  'ruby',
  'rust',
  'sql',
  'swift',
  'toml',
  'tsx',
  'typescript',
  'xml',
  'yaml'
] as const

export type LazyLangId = (typeof LAZY_LANG_IDS)[number]

/** The module ids to list in a Vite `optimizeDeps.include`: the grammars and the shiki core they load with. */
export const LAZY_LANG_MODULES = ['shiki/core', 'shiki/engine/javascript', ...LAZY_LANG_IDS.map((id) => `@shikijs/langs/${id}`)]
