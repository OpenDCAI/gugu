#!/usr/bin/env tsx
/**
 * codegen/run.ts — Theme code generation orchestrator.
 *
 * Imports all theme definitions, resolves them into CSS + TS artifacts,
 * and writes the output files.
 *
 * Emits:
 *   theme/__generated__/theme.css           — @layer tokens { :root palette vars + per-.em<id> semantic + syntax vars }
 *   theme/__generated__/semantic.css        — @layer tokens { per-theme semantic vars (imported separately) }
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { darkTheme } from '../../themes/dark.theme';
import { lightTheme } from '../../themes/light.theme';
import { solarizedDarkTheme } from '../../themes/solarized-dark.theme';
import { solarizedLightTheme } from '../../themes/solarized-light.theme';
import type { ResolvedTheme } from '../define-theme';
import { emitSemanticCss } from './emit-semantic-css';
import { emitThemeCss } from './emit-theme-css';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Output directories — generated CSS lands in theme/__generated__/
const GENERATED_DIR = join(__dirname, '..', '..', '__generated__');

const ALL_THEMES: ResolvedTheme[] = [
  lightTheme,
  darkTheme,
  solarizedLightTheme,
  solarizedDarkTheme,
];

function run(): void {
  const themes = ALL_THEMES;

  console.log(`Building ${themes.length} theme(s): ${themes.map((t) => t.id).join(', ')}`);

  // Ensure output directory exists
  mkdirSync(GENERATED_DIR, { recursive: true });

  // theme/__generated__/theme.css
  writeFileSync(join(GENERATED_DIR, 'theme.css'), emitThemeCss(themes), 'utf8');
  console.log('✓ theme/__generated__/theme.css');

  // theme/__generated__/semantic.css
  writeFileSync(join(GENERATED_DIR, 'semantic.css'), emitSemanticCss(themes), 'utf8');
  console.log('✓ theme/__generated__/semantic.css');

  console.log('\nTheme build complete.');
}

run();
