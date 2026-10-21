import { defineConfig } from 'i18next-cli'

export default defineConfig({
  locales: ['zh-CN', 'en-US'],
  extract: {
    input: [
      'apps/desktop/src/**/*.{ts,tsx}',
      'packages/session-ui/src/**/*.{ts,tsx}',
      'packages/session-chat-ui/src/**/*.{ts,tsx}',
    ],
    ignore: [
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
      '**/*.stories.{ts,tsx}',
      '**/tests/**',
      '**/mock*/**',
      '**/__generated__/**',
    ],
    output: 'apps/desktop/src/i18n/locales/{{language}}/{{namespace}}.ts',
    outputFormat: 'ts',
    defaultNS: 'common',
    primaryLanguage: 'zh-CN',
    secondaryLanguages: ['en-US'],
    removeUnusedKeys: false,
    allPluralForms: true,
    extractFromComments: false,
    warnOnConflicts: 'error',
  },
  lint: {
    ignoredAttributes: ['data-testid', 'data-state', 'data-slot'],
    ignoredTags: ['code', 'pre'],
    checkInterpolationParams: true,
    checkConcatenation: 'error',
    checkPunctuationConcatenation: 'warn',
  },
})
