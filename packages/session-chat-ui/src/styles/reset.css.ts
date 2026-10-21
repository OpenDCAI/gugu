/**
 * reset.css.ts — minimal CSS reset to replace the box-sizing + element resets
 * that Tailwind's preflight provided.
 *
 * KEY RISK: this reset must NOT change any element heights that pretext measures.
 * Run markdown-rows/diff/execute contract tests after any edit here.
 *
 * We intentionally do NOT include a full Tailwind preflight equivalent — only
 * the rules that chat-ui components actually rely on:
 *   - box-sizing: border-box on all elements
 *   - margin: 0 on block elements used in chat (p, h1-h6, etc.)
 *   - list-style: none on ul/ol
 * These are the rules Tailwind's preflight sets that affect layout height.
 *
 * Font-face @imports stay in chat.module.css (to be renamed chat-fonts.css).
 */

import { globalLayer, globalStyle } from '@vanilla-extract/css';

// The only layer this package declares. It exists for the `button` rule at the
// bottom of this file — see the SCOPE note there for why that rule must be
// layered and the rest of this file must not be. One layer, one user, so it is
// declared here rather than in a layers.css.ts of its own (contrast
// `@gugu/session-ui`, which orders five layers and needs the separate module).
//
// Position: `reset` is the LOWEST layer in every host that also declares others.
// In the product `apps/desktop/src/styles/tokens.css` declares the combined
// order (`@layer reset, tokens, theme, base, components, recipes, utilities;`)
// before either stack emits a rule, and chat-ui's CSS arrives later still — it
// loads lazily, when `chat-transcript.tsx` first `import()`s this package — so
// this declaration re-states a position that is already fixed rather than
// claiming a new one. In Storybook and the contract harness it is the only
// layer that exists.
const resetLayer = globalLayer('reset');

// Border-box sizing — prevents padding from bloating element dimensions.
globalStyle('*, *::before, *::after', {
  boxSizing: 'border-box',
});

// Zero out default browser margins on block elements used inside chat.
globalStyle('p, h1, h2, h3, h4, h5, h6, ul, ol, li, blockquote, pre, table, figure', {
  margin: 0,
  padding: 0,
});

// Remove bullet points that would shift list geometry.
globalStyle('ul, ol', {
  listStyle: 'none',
});

// Tables use border-collapse + border-spacing:0 inline; ensure no extra gaps.
globalStyle('table', {
  borderCollapse: 'separate',
  borderSpacing: 0,
});

// Strip the UA button chrome (2px outset border, `buttonface` fill, 1px 6px
// padding, 13.333px system font). Without this a chat-ui button that does not
// reset locally renders as a raised grey OS button — and, being UA chrome, it
// keeps the same light grey in the dark theme.
//
// This does not change the product, which never showed that chrome: the task
// renderer imports Tailwind, whose preflight already sets `border: 0 solid` on
// `*` and `background-color: transparent` on `button` across the whole document
// (both stylesheets share one `<head>` since #2804). What it changes is that
// the package no longer depends on its host shipping preflight to look right —
// Storybook and the contract harness mount chat-ui without it, so before this
// they showed decoration the product does not have.
// The declarations mirror preflight's own button block (`font`/`color: inherit`,
// `border-radius: 0`, `background-color: transparent`) plus the `border: 0` and
// `padding: 0` it applies through `*`, so the two agree rather than merely
// overlapping.
//
// SCOPE — this rule is LAYERED, and it is the one rule in this file that must be.
// Since #2804 its scope is the whole host document, not this package: chat-ui's
// stylesheet shares one `<head>` with the task renderer's Tailwind and with the
// Gugu shell's. An unlayered normal declaration beats every rule inside any
// `@layer`, specificity irrelevant, and Tailwind's utilities live in
// `@layer utilities` — so while this rule was unlayered it outranked them and
// "a local utility class wins on specificity" was not a route that existed at
// all. Every one of the six declarations below had that reach, not just padding:
// `padding` killed `px-*`/`py-*`/`p-*`, `background` killed `bg-*`,
// `border-radius` killed `rounded-*`, `border` killed `border-*`, `color` killed
// `text-<color>`, and `font` — a shorthand — killed `text-<size>`, `font-*` and
// `leading-*` together. Written on a `<button>` anywhere in the host, those were
// dead classes: the name sat in the class attribute and the computed value was
// the reset's.
//
// Inside `@layer reset` the rule keeps doing its job and stops doing that. Per
// host:
//   - product — Tailwind's preflight (`@layer base`) sets the same zeroes on
//     `button`, so the chrome stays stripped; `@layer utilities` now outranks
//     both, so a utility on a `<button>` computes to what its author wrote.
//   - Storybook / contract harness — no preflight and no other layer exists, so
//     this rule is still the only thing zeroing the UA chrome. That is why it
//     must NOT be deleted: without it those two hosts show a raised grey OS
//     button (and, being UA chrome, the same grey in the dark theme) that the
//     product has never shown.
// The zeroing is therefore load-bearing in two hosts and redundant in the third,
// which is the whole reason layering is the fix and removal is not.
//
// The blast radius was measured on the running product rather than inferred, both
// before and after: `e2e/electron/button-padding-cascade-3490.spec.ts`(#6270 已删) reads
// computed style off the laid-out DOM, and its criterion is TAG NEUTRALITY — the
// same class list on a `<button>` and on an otherwise identical `<div>` must
// compute the same value. It deliberately does not know the word "layer", only
// the consequence, so reintroducing the same failure by another route still turns
// it red. ❌ Do not replace it with "this rule must carry `@layer`": that is
// trivially true now and can only prove the line still exists, not that the
// consequence is gone.
//
// chat-ui's OWN buttons did not move, and the reason is worth keeping: it was
// never that they outranked this rule. `CopyButton`'s same-class `<div>` control
// also computes 0, i.e. `copyButtonInline` declares no padding at all — nothing
// won, there was nothing to win. Under the unlayered rule a `px-*` added to a
// chat-ui button would have been dead too; that is no longer the case in the
// product, and in Storybook this package's own unlayered VE styles outrank
// `@layer reset` anyway.
globalStyle('button', {
  '@layer': {
    [resetLayer]: {
      border: 0,
      borderRadius: 0,
      padding: 0,
      background: 'transparent',
      font: 'inherit',
      color: 'inherit',
    },
  },
});
