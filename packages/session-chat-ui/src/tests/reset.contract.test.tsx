/**
 * reset.contract — what `styles/reset.css.ts` owes THIS host, measured here.
 *
 * The contract harness is one of the two hosts that mount chat-ui without
 * Tailwind's preflight (Storybook is the other). Here the `button` reset is the
 * only thing stripping the UA button chrome, so this file measures both halves
 * of what layering that rule has to preserve:
 *
 *   ① the chrome is still stripped — a bare `<button>` computes zeroes;
 *   ② a LAYERED utility now outranks the reset — which is the whole point of
 *      #3512, and the half that a "the rule still carries `@layer`" check
 *      cannot see. While the reset was unlayered it beat every `@layer` rule
 *      regardless of specificity, so ② computed 0 and the utility was a dead
 *      class.
 *
 * ① needs a positive control or it is not a reading. "padding is 0" and "this
 * engine has no UA button padding to strip" are the same number, so every zero
 * here is paired with a `<button>` inside an open shadow root: the UA stylesheet
 * applies in shadow trees but document author styles do not, so that button
 * shows the chrome this reset exists to remove. If the control ever reads 0 the
 * assertions below are void, not passing.
 */

import { afterEach, describe, expect, it } from 'vitest';

const HOST_ID = 'reset-contract-host';

function mountHost(): HTMLElement {
  const host = document.createElement('div');
  host.id = HOST_ID;
  // Give the host a font and colour unlike the UA button defaults, so
  // `font: inherit` / `color: inherit` are observable rather than coincidental.
  host.style.fontFamily = 'Georgia, serif';
  host.style.fontSize = '19px';
  host.style.color = 'rgb(12, 34, 56)';
  document.body.append(host);
  return host;
}

/** A `<button>` the document's author styles cannot reach — i.e. UA chrome only. */
function mountShadowedControl(): HTMLButtonElement {
  const carrier = document.createElement('div');
  carrier.dataset.resetContract = 'shadow-control';
  document.body.append(carrier);
  const shadow = carrier.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  button.textContent = 'ua chrome';
  shadow.append(button);
  return button;
}

function quad(el: Element): [number, number, number, number] {
  const cs = getComputedStyle(el);
  return [
    Number.parseFloat(cs.paddingTop),
    Number.parseFloat(cs.paddingRight),
    Number.parseFloat(cs.paddingBottom),
    Number.parseFloat(cs.paddingLeft),
  ];
}

afterEach(() => {
  document.getElementById(HOST_ID)?.remove();
  document.querySelectorAll('[data-reset-contract]').forEach((el) => el.remove());
});

describe('button reset in the contract harness host', () => {
  it('strips the UA chrome a shadow-rooted control still shows', () => {
    const host = mountHost();
    const button = document.createElement('button');
    button.textContent = 'bare';
    host.append(button);

    const control = mountShadowedControl();
    const controlStyle = getComputedStyle(control);
    const controlPadding = quad(control);

    // Positive control first: if the engine ships no button chrome, the zeroes
    // below measure nothing.
    expect(
      controlPadding.some((v) => v > 0),
      `UA control shows no padding (${controlPadding.join('/')}) — this host has no ` +
        'button chrome to strip, so the zeroes in this test are not evidence'
    ).toBe(true);
    expect(
      Number.parseFloat(controlStyle.borderTopWidth),
      'UA control shows no border — same void reading as above'
    ).toBeGreaterThan(0);

    const style = getComputedStyle(button);
    expect(quad(button), 'bare button keeps UA padding').toEqual([0, 0, 0, 0]);
    expect(Number.parseFloat(style.borderTopWidth)).toBe(0);
    expect(Number.parseFloat(style.borderTopLeftRadius)).toBe(0);
    // transparent — `rgba(0, 0, 0, 0)`, whatever the platform's ButtonFace is.
    expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    // font/colour come from the host, not from the UA's 13.333px system stack.
    expect(style.fontFamily).toBe('Georgia, serif');
    expect(style.fontSize).toBe('19px');
    expect(style.color).toBe('rgb(12, 34, 56)');
    expect(
      controlStyle.fontFamily,
      'UA control inherited the host font — then `font: inherit` proves nothing'
    ).not.toBe('Georgia, serif');
  });

  it('loses to a layered utility, the way Tailwind utilities do in the product', () => {
    const host = mountHost();
    const button = document.createElement('button');
    button.className = 'reset-contract-px';
    button.textContent = 'utility';
    host.append(button);

    // Stand in for `@layer utilities`. The name is undeclared in this host, so
    // it registers after `reset` and therefore outranks it — exactly the
    // relationship Tailwind's utilities layer has with it in the product.
    const sheet = document.createElement('style');
    sheet.dataset.resetContract = 'layered-utility';
    sheet.textContent =
      '@layer utilities { .reset-contract-px { padding-left: 12px; border-radius: 7px; } }';
    document.head.append(sheet);

    const style = getComputedStyle(button);
    expect(
      Number.parseFloat(style.paddingLeft),
      'a layered utility lost to the reset — the reset is unlayered again, and ' +
        'every `px-*` on a `<button>` in the host document is a dead class (#3512)'
    ).toBe(12);
    expect(Number.parseFloat(style.borderTopLeftRadius)).toBe(7);

    sheet.remove();
    expect(
      Number.parseFloat(getComputedStyle(button).paddingLeft),
      'reset stopped applying once the utility was withdrawn'
    ).toBe(0);
  });
});
