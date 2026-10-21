/**
 * Thin helpers around pretext's `prepareRichInline`.
 *
 * The per-instance richInlineCache has moved to ChatCaches (core/caches.ts).
 * This module now exports:
 *   registerFontsReadyClear  — font-load hook; calls onCleared which should
 *                              invoke caches.clearTextMeasure() + remeasure.
 *   clearPretextInternalCaches — flush pretext's internal global caches (re-exported
 *                               for use from ChatCaches.clearTextMeasure).
 */

export { clearCache as clearPretextInternalCaches } from '@chenglou/pretext';
import type { FontConfig } from '@session-chat/core/config';

const FONT_VARIANTS = [
  'body',
  'bold',
  'italic',
  'boldItalic',
  'link',
  'h1',
  'h2',
  'h3',
  'inlineCode',
  'mention',
  'code',
] as const satisfies ReadonlyArray<keyof FontConfig>;

/**
 * KaTeX faces the math measurement tier lays formulas out against.
 *
 * Not measured by pretext — KaTeX sizes its own boxes — but they arrive on the
 * same late schedule as the body fonts and get the same treatment, because a
 * formula measured against a fallback face reserves a band the real glyphs do
 * not fit. Main/Math cover ordinary expressions, AMS the symbol set, and Size1/2
 * the grown delimiters and radicals that make a formula tall in the first place.
 * A face the host has not declared simply resolves to an empty face set — a
 * no-op, not an error.
 */
const KATEX_FONT_SPECS = [
  '16px KaTeX_Main',
  'italic 16px KaTeX_Math',
  '16px KaTeX_AMS',
  '16px KaTeX_Size1',
  '16px KaTeX_Size2',
] as const;

export function fontLoadSpecs(fonts: FontConfig): string[] {
  return [
    ...new Set([...FONT_VARIANTS.map((variant) => fonts[variant].font), ...KATEX_FONT_SPECS]),
  ];
}

/**
 * Eagerly load the bundled named fonts, then call `onCleared`
 * (which should invoke `caches.clearTextMeasure()` + `virtualizer.measure()`).
 *
 * Using `document.fonts.load(spec)` instead of `document.fonts.ready` ensures
 * we wait for the exact faces pretext needs, not just "all fonts document-wide".
 * Without this, pretext measures with the fallback metrics during first paint
 * and produces wrong line-break positions until the cache is cleared.
 *
 * Call this once when ChatTranscript mounts.
 */
export function registerFontsReadyClear(fonts: FontConfig, onCleared?: () => void): void {
  if (typeof document === 'undefined') return;
  void Promise.all(fontLoadSpecs(fonts).map((spec) => document.fonts.load(spec))).then(() => {
    onCleared?.();
  });
}
