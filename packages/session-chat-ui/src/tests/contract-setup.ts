/**
 * Browser test setup — imports the global CSS chain required for the
 * measurement contract tests. Mirrors the Storybook preview.css chain.
 */
import { beforeAll } from 'vitest';
import '../styles/global.css';
import { clearMathMeasure } from '../components/rows/markdown/math/layout';
import { fontLoadSpecs } from '../core/measure/pretext-cache';
import { DEFAULT_THEME } from '../core/theme';

/**
 * Resolve every measured face before the first `measure()` runs.
 *
 * A contract test measures, then mounts, then waits for paint. If a face
 * finishes loading inside that window the measurement was taken against a
 * fallback and the render against the real font, and the two disagree for
 * reasons that have nothing to do with the code under test. Production solves
 * this with `registerFontsReadyClear` — an epoch bump and a re-measure once the
 * faces land; the harness has no epoch, so it waits up front instead.
 *
 * The math cache is dropped afterwards for the same reason it is dropped on the
 * production font-load hook: anything typeset before the KaTeX faces resolved
 * is a measurement of the wrong typeface.
 */
beforeAll(async () => {
  await Promise.all(fontLoadSpecs(DEFAULT_THEME.fonts).map((spec) => document.fonts.load(spec)));
  await document.fonts.ready;
  clearMathMeasure();
});
