/**
 * The ```svg figure in a real browser: what an agent can put in it never runs or fetches, its theme tokens become
 * this theme's colours, and one that cannot be drawn says why instead of drawing something else.
 */
import { describe, expect, it } from 'vitest';
import { SVG_FIGURE_MAX_BYTES, svgFigure } from './figure';

const PALETTE = { fg: 'rgb(1, 2, 3)', c1: '#2a78d6' };

function decoded(src: string): string {
  return decodeURIComponent(src.slice(src.indexOf(',') + 1));
}

function load(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image did not load'));
  });
  image.src = src;
  document.body.append(image);
  return loaded;
}

describe('svgFigure', () => {
  it('draws at its viewBox size with theme tokens written in', async () => {
    const figure = svgFigure('<svg viewBox="0 0 400 200"><rect width="10" height="10" fill="var(--c1)"/><text fill="var(--fg, #000)">a</text></svg>', PALETTE);
    if (!figure.ok) throw new Error(figure.reason);
    expect([figure.width, figure.height]).toEqual([400, 200]);
    const markup = decoded(figure.src);
    expect(markup).toContain('fill="#2a78d6"');
    expect(markup).toContain('fill="rgb(1, 2, 3)"');
    expect(markup).toContain('color="rgb(1, 2, 3)"');
    const image = await load(figure.src);
    expect([image.naturalWidth, image.naturalHeight]).toEqual([400, 200]);
  });

  it('leaves an unknown token alone', () => {
    const figure = svgFigure('<svg viewBox="0 0 1 1"><rect fill="var(--nope)"/></svg>', PALETTE);
    expect(figure.ok && decoded(figure.src)).toContain('var(--nope)');
  });

  it('runs no script and fetches nothing', async () => {
    const probe = `${location.origin}/__svg-figure-probe-${Date.now()}.png`;
    const flag = '__svgFigureRan';
    const figure = svgFigure(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="parent.${flag}=1">`
        + `<script>parent.${flag}=1</script><image href="${probe}" width="10" height="10"/><image xlink:href="${probe}?x" width="10" height="10"/></svg>`,
      PALETTE,
    );
    if (!figure.ok) throw new Error(figure.reason);
    // The page itself can fetch the probe: the instrument would see a request the figure made.
    const control = await fetch(`${probe}?control`).then(() => true, () => true);
    expect(control).toBe(true);
    await load(figure.src);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const requested = performance.getEntriesByType('resource').map((entry) => entry.name);
    expect(requested).toContain(`${probe}?control`);
    expect(requested.filter((name) => name.startsWith(probe) && !name.endsWith('?control'))).toEqual([]);
    expect((window as unknown as Record<string, unknown>)[flag]).toBeUndefined();
  });

  it('says why it cannot draw', () => {
    expect(svgFigure('<svg><rect/></svg>', PALETTE)).toEqual({ ok: false, reason: 'no-viewbox' });
    expect(svgFigure('<svg viewBox="0 0 0 10"/>', PALETTE)).toEqual({ ok: false, reason: 'no-viewbox' });
    expect(svgFigure('<svg viewBox="0 0 10 10"><rect></svg>', PALETTE)).toEqual({ ok: false, reason: 'invalid' });
    expect(svgFigure('<div>no</div>', PALETTE)).toEqual({ ok: false, reason: 'invalid' });
    const big = `<svg viewBox="0 0 10 10"><!--${'x'.repeat(SVG_FIGURE_MAX_BYTES)}--></svg>`;
    expect(svgFigure(big, PALETTE)).toEqual({ ok: false, reason: 'too-large' });
  });
});
